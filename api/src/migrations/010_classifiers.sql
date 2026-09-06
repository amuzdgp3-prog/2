-- A Location's parent_id gives it exactly one place in a single tree — fine for the point itself
-- (an address only stands in one physical spot), but wrong for organising addresses: the owner
-- wants to group the same address under several independent, cross-cutting labels at once (e.g.
-- both "СПб Юг" and, say, "Торговые центры" — a venue-type label that has nothing to do with
-- geography and would span both Север and Юг). A classifier is a plain many-to-many tag on
-- Location, orthogonal to the parent_id tree, so an address can carry as many as apply.
CREATE TABLE classifiers (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE location_classifiers (
  location_id   BIGINT NOT NULL REFERENCES locations(id),
  classifier_id BIGINT NOT NULL REFERENCES classifiers(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, classifier_id)
);

-- Technician scope by classifier, alongside the existing by-location-subtree grant in
-- staff_location_scope: "give this technician every address tagged Юг" without needing that tag
-- to also be a place in the parent_id tree.
CREATE TABLE staff_classifier_scope (
  staff_id      BIGINT NOT NULL REFERENCES staff(id),
  classifier_id BIGINT NOT NULL REFERENCES classifiers(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, classifier_id)
);

CREATE INDEX location_classifiers_classifier_idx ON location_classifiers (classifier_id);
CREATE INDEX staff_classifier_scope_classifier_idx ON staff_classifier_scope (classifier_id);
