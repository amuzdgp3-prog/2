-- Каталог: classifiers become a self-referencing tree (parent_id, nullable → every existing row
-- becomes a root automatically) instead of a flat list. This is the owner's new primary
-- organising mechanism (city → district → venue type, machine type, floor — anything, with a
-- single address or machine free to belong to several nodes at once). locations.parent_id and
-- its recursive scope_tree branch in lib/scope.ts are left structurally as-is — the owner is only
-- retiring the location-tree "move" UI action in favour of Каталог, not the schema.
--
-- A catalog node can now tag a Location (as before, via location_classifiers) OR a specific
-- Machine directly (new machine_classifiers, mirroring location_classifiers row-for-row):
-- geographic/venue tags belong to the address by default (a replacement machine placed there
-- inherits them automatically; a machine that moves away loses them), but a rare mixed-address
-- case needs to tag one machine directly, bypassing its address. See lib/scope.ts for how both
-- paths resolve through the same recursive classifier subtree.

ALTER TABLE classifiers ADD COLUMN parent_id BIGINT REFERENCES classifiers (id);
ALTER TABLE classifiers ADD CONSTRAINT classifiers_not_own_parent CHECK (parent_id IS DISTINCT FROM id);
CREATE INDEX classifiers_parent_idx ON classifiers (parent_id);

CREATE TABLE machine_classifiers (
    machine_number TEXT   NOT NULL REFERENCES machines (machine_number),
    classifier_id  BIGINT NOT NULL REFERENCES classifiers (id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (machine_number, classifier_id)
);

CREATE INDEX machine_classifiers_classifier_idx ON machine_classifiers (classifier_id);
