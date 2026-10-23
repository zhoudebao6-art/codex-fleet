CREATE TABLE power_nodes (node text PRIMARY KEY NOT NULL, report text NOT NULL, reported_at text NOT NULL, mode text NOT NULL DEFAULT 'available');
--> statement-breakpoint
CREATE TABLE wake_actions (id text PRIMARY KEY NOT NULL,node text NOT NULL,creator text NOT NULL,probe integer NOT NULL DEFAULT 0,relays text NOT NULL,status text NOT NULL,detail text NOT NULL,created_at text NOT NULL,updated_at text NOT NULL,expires_at text NOT NULL);
--> statement-breakpoint
CREATE INDEX wake_actions_node_created ON wake_actions(node,created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX wake_actions_active ON wake_actions(node) WHERE status IN ('queued','sent','online');
--> statement-breakpoint
CREATE TABLE wake_receipts (action text NOT NULL,node text NOT NULL,status text NOT NULL,receipt text NOT NULL,digest text NOT NULL,created_at text NOT NULL,PRIMARY KEY(action,node));
