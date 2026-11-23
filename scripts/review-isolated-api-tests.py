#!/usr/bin/env python3
"""Run API tests in a fresh disposable local Docker cluster with synthetic data.

Requires local postgres:16-alpine and 2-api:latest images and api/node_modules.
No images are pulled. Only created container/network IDs are removed.
Evidence and test output remain in a unique /tmp directory.
Use --preflight-only to verify isolation, tsx, PostgreSQL and ffmpeg without tests.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
DOCKER_ENV = {key: value for key, value in os.environ.items() if not key.startswith('DOCKER_')}
DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']
MOUNTS = ['api/src', 'api/tests', 'api/node_modules', 'api/package.json',
          'api/tsconfig.json', 'web/src/dateFormat.ts']


def docker(*args, check=True, **kwargs):
    return subprocess.run(DOCKER + list(args), env=DOCKER_ENV, check=check, text=True, **kwargs)


def output(*args):
    return docker(*args, capture_output=True).stdout.strip()


def inspect(kind, target):
    return json.loads(output(kind, 'inspect', target))[0]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def source_hashes():
    files = [Path(__file__).resolve(), ROOT / 'api/package-lock.json']
    for relative in MOUNTS:
        if relative == 'api/node_modules':
            continue
        path = ROOT / relative
        files.extend(sorted(path.rglob('*')) if path.is_dir() else [path])
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in files if path.is_file()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preflight-only', action='store_true')
    args = parser.parse_args()
    run_id = 'site2-audit-' + uuid.uuid4().hex[:12]
    evidence_dir = Path(tempfile.mkdtemp(prefix=run_id + '-'))
    proof_path = evidence_dir / 'isolation.json'
    log_path = evidence_dir / 'api-tests.log'
    proof = {'run_id': run_id, 'mode': 'preflight' if args.preflight_only else 'all-api-tests',
             'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()}
    resources = []
    exit_code = 1
    print('ISOLATION_PROOF=' + str(proof_path), flush=True)
    try:
        require(all((ROOT / path).exists() and not (ROOT / path).is_symlink() for path in MOUNTS),
                'Expected regular source/dependency mounts are missing or symlinked')
        tests = [str(path.relative_to(ROOT / 'api')) for path in sorted((ROOT / 'api/tests').glob('*.test.ts'))]
        require(bool(tests), 'No API tests found')
        proof['source_hashes_before'] = source_hashes()
        pg_image = inspect('image', 'postgres:16-alpine')['Id']
        api_image = inspect('image', '2-api:latest')['Id']
        proof['images'] = {'postgres': pg_image, 'runtime': api_image}
        network = output('network', 'create', '--internal', '--label', 'site2.audit=' + run_id, run_id)
        resources.append(('network', network))
        require(inspect('network', network)['Internal'] is True, 'Network must be internal')
        db = output('create', '--name', run_id + '-db', '--label', 'site2.audit=' + run_id,
                    '--network', network, '--tmpfs', '/var/lib/postgresql/data:rw',
                    '--memory', '1g', '--pids-limit', '256', '-e', 'POSTGRES_DB=apixspb_test',
                    '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=disposable-audit-only', pg_image)
        resources.append(('container', db))
        meta = inspect('container', db)
        require(not meta['Mounts'] and list(meta['HostConfig']['Tmpfs']) == ['/var/lib/postgresql/data'],
                'PostgreSQL must use only fresh tmpfs storage')
        require(not meta['HostConfig']['PortBindings'], 'Published database ports are forbidden')
        require(list(meta['NetworkSettings']['Networks']) == [run_id], 'Unexpected database network')
        output('start', db)
        for _ in range(100):
            ready = docker('exec', db, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres',
                           '-d', 'apixspb_test', check=False, capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(.2)
        else:
            raise RuntimeError('Fresh PostgreSQL did not become ready')
        identity = json.loads(output('exec', db, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
            '-d', 'apixspb_test', '-Atc', "SELECT json_build_object('database',current_database(),"
            "'user',current_user,'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),"
            "'user_table_count',(SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')));"))
        require(identity['database'] == 'apixspb_test' and identity['user'] == 'postgres'
                and identity['user_table_count'] == 0, 'Database identity/empty-schema check failed')
        proof.update(network={'id': network, 'internal': True},
                     database={'container_id': db, 'mounts': meta['Mounts'],
                               'tmpfs': meta['HostConfig']['Tmpfs'], 'published_ports': False,
                               'identity_before_tests': identity})
        command = ['node', '--import', 'tsx', '--test', '--test-concurrency=1', *tests]
        if args.preflight_only:
            command = ['node', '--import', 'tsx', '--input-type=module', '-e',
                       "import pg from 'pg'; import {execFileSync} from 'node:child_process';"
                       "const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});"
                       "console.log('Node',process.version);"
                       "console.log(execFileSync('ffmpeg',['-version'],{encoding:'utf8'}).split('\\n')[0]);"
                       "console.log((await pool.query('SELECT current_database(),current_user')).rows);"
                       "await pool.end();"]
        cmd = ['create', '--name', run_id + '-tests', '--label', 'site2.audit=' + run_id,
               '--network', 'container:' + db, '--user', str(os.getuid()) + ':' + str(os.getgid()),
               '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
               '--tmpfs', '/tmp:rw,mode=1777', '--memory', '2g', '--pids-limit', '256']
        for relative in MOUNTS:
            cmd += ['--mount', 'type=bind,source=' + str(ROOT / relative)
                    + ',target=/workspace/' + relative + ',readonly']
        cmd += ['--workdir', '/workspace/api', '--entrypoint', '/usr/bin/env', api_image, '-i',
                'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                'HOME=/tmp', 'TMPDIR=/tmp', 'NODE_ENV=test', 'TZ=UTC',
                'DATABASE_URL=postgres://postgres:disposable-audit-only@127.0.0.1:5432/apixspb_test',
                'JWT_SECRET=disposable-audit-secret', 'LOG_LEVEL=error', 'PHOTO_DIR=/tmp/site2-audit-photos',
                'PUBLIC_ORIGIN=http://127.0.0.1', 'DB_MIGRATE_ON_START=0',
                'IVEND_GRAPHQL_URL=http://127.0.0.1:9/ivend', 'RESEND_API_BASE=http://127.0.0.1:9',
                'TELEGRAM_API_BASE=http://127.0.0.1:9', *command]
        runtime = output(*cmd)
        resources.append(('container', runtime))
        rt = inspect('container', runtime)
        require(rt['HostConfig']['NetworkMode'] == 'container:' + db, 'Unexpected runtime network')
        require(rt['HostConfig']['ReadonlyRootfs'] and not rt['HostConfig']['Privileged']
                and not rt['HostConfig']['PortBindings'] and set(rt['HostConfig']['CapDrop']) == {'ALL'},
                'Runtime privilege/storage/port check failed')
        expected_mounts = {(str(ROOT / path), '/workspace/' + path) for path in MOUNTS}
        require({(mount['Source'], mount['Destination']) for mount in rt['Mounts']} == expected_mounts
                and all(not mount['RW'] and mount['Type'] == 'bind' for mount in rt['Mounts']),
                'Runtime mounts must exactly match the read-only allowlist')
        proof['runtime'] = {'container_id': runtime, 'network_mode': 'container:' + db,
                            'readonly_root': True, 'tmpfs_photos': True, 'clean_env': True,
                            'test_files': 0 if args.preflight_only else len(tests),
                            'mounts': [{key: mount[key] for key in ['Type', 'Source', 'Destination', 'RW']}
                                       for mount in rt['Mounts']]}
        proof_path.write_text(json.dumps(proof, indent=2) + '\n')
        with log_path.open('w') as log:
            docker('start', '-a', runtime, check=False, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
        state = inspect('container', runtime)['State']
        proof['runtime']['state'] = {key: state[key] for key in ['Status', 'Running', 'ExitCode', 'OOMKilled', 'Error']}
        require(state['Status'] == 'exited' and not state['Running'], 'Runtime did not finish; attach result is incomplete')
        exit_code = int(state['ExitCode'])
        require(not state['OOMKilled'] and not state['Error'], 'Runtime launch failed or ran out of memory')
        proof['sources_unchanged'] = source_hashes() == proof['source_hashes_before']
        require(proof['sources_unchanged'], 'Source files changed during verification')
        proof['test_exit_code'] = exit_code
        print('API_TEST_EXIT_CODE=' + str(exit_code), flush=True)
        print('API_TEST_LOG=' + str(log_path), flush=True)
        print('\n'.join(log_path.read_text().splitlines()[-30:]), flush=True)
    finally:
        cleanup = []
        for kind, resource_id in reversed(resources):
            result = docker(*(['rm', '-f', resource_id] if kind == 'container'
                             else ['network', 'rm', resource_id]), check=False, capture_output=True)
            cleanup.append({'kind': kind, 'id': resource_id, 'exit_code': result.returncode})
        proof['cleanup'] = cleanup
        proof_path.write_text(json.dumps(proof, indent=2) + '\n')
        if any(result['exit_code'] for result in cleanup):
            print('CLEANUP_FAILED: inspect isolation.json; created resources may remain', file=sys.stderr)
            exit_code = 1
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
