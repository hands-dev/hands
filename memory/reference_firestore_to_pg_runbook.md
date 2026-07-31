---
name: Firestore→PostgreSQL migration runbook
description: Step-by-step operational runbook for migrating a Firestore environment to Cloud SQL PostgreSQL — covers infra provisioning, schema setup, data migration, and gotchas encountered during staging migration
type: reference
---

## Runbook: Firestore → PostgreSQL Migration (per environment)

Executed successfully against staging on 2026-03-25. Use this for production.

### Prerequisites
- `gcloud` CLI authenticated (`gcloud auth login`)
- `cloud-sql-proxy` installed (`brew install cloud-sql-proxy`)
- `psql` available (`brew install postgresql`)
- Firebase service account JSON in Secret Manager (key: `web-firebase-service-account`)
- Terraform state initialized for the target environment

### Step 1: Enable APIs (if new project)
```bash
gcloud services enable sqladmin.googleapis.com vpcaccess.googleapis.com \
  secretmanager.googleapis.com servicenetworking.googleapis.com \
  compute.googleapis.com --project=PROJECT_ID
```

### Step 2: Terraform Apply
```bash
cd apps/infra/environments/ENVIRONMENT
terraform init -upgrade
terraform apply \
  -var='mandrill_api_key=FROM_1PASSWORD' \
  -var='secret_key=FROM_1PASSWORD' \
  -var='and_server_auth_token=FROM_1PASSWORD' \
  -var='admin_auth_secret=FROM_1PASSWORD'
```
Takes ~15 min (Cloud SQL instance creation is the bottleneck).

**For production:** Edit `terraform.tfvars` to set:
- `deletion_protection = true`
- `high_availability = true` (REGIONAL)
- `tier = "db-g1-small"` or larger

### Step 3: Enable Public IP (for local proxy access)
Cloud SQL with private-IP-only cannot accept connections via the Auth Proxy from outside the VPC.
```bash
gcloud sql instances patch INSTANCE_NAME --project=PROJECT_ID --assign-ip --quiet
```
**Gotcha:** This takes ~30s to propagate. Wait before connecting.
**TODO:** Disable public IP after migration is done: `--no-assign-ip`

### Step 4: Start Cloud SQL Auth Proxy
```bash
cloud-sql-proxy "PROJECT_ID:us-central1:INSTANCE_NAME" --port=5433
```
Verify connectivity:
```bash
PGPASSWORD="PASSWORD" psql -h 127.0.0.1 -p 5433 -U ampersand -d ampersand -c "SELECT version();"
```

### Step 5: Apply Schema Migrations
```bash
for f in packages/db/migrations/*.sql; do
  echo "Applying: $f"
  sed 's/--> statement-breakpoint//' "$f" | \
  PGPASSWORD="PASSWORD" psql -h 127.0.0.1 -p 5433 -U ampersand -d ampersand
done
```
**Note:** `drizzle-kit migrate` doesn't work because it uses the `pg` driver but we use `postgres` (postgres.js). Apply SQL files directly via psql.

Verify: `\dt` should show 11 tables.

### Step 6: Drop FK Constraints (temporary)
The Firestore data has entity-owned tags where `claimedByAndeeId` points to entity IDs (not andee IDs), and some legacy Firebase UIDs that don't match any andee doc. Drop FKs before inserting:
```sql
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_claimed_by_andee_id_andees_id_fk;
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_reserved_by_andee_id_andees_id_fk;
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_accepted_by_andee_id_andees_id_fk;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_andee_id_andees_id_fk;
ALTER TABLE email_logs DROP CONSTRAINT IF EXISTS email_logs_andee_id_andees_id_fk;
ALTER TABLE email_verification_tokens DROP CONSTRAINT IF EXISTS email_verification_tokens_andee_id_andees_id_fk;
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_payment_id_payments_id_fk;
```

### Step 7: Run Data Migration
Dry run first:
```bash
FIREBASE_SERVICE_ACCOUNT_JSON=$(gcloud secrets versions access latest --secret=web-firebase-service-account --project=PROJECT_ID) \
DATABASE_URL="postgresql://ampersand:PASSWORD@127.0.0.1:5433/ampersand" \
pnpm -F @ampersand/db migrate:firestore -- --dry-run
```

Then execute:
```bash
FIREBASE_SERVICE_ACCOUNT_JSON=$(gcloud secrets versions access latest --secret=web-firebase-service-account --project=PROJECT_ID) \
DATABASE_URL="postgresql://ampersand:PASSWORD@127.0.0.1:5433/ampersand" \
pnpm -F @ampersand/db migrate:firestore
```

**Staging results (2026-03-25):** 918 Firestore docs → 876 PG rows
- 409/450 andees (41 skipped = duplicate phone numbers, test accounts)
- 405/406 tags (1 duplicate)
- 40 invitations, 7 employees, 5 payments, 8 email logs, 2 app config

### Step 8: Clean Orphaned FKs and Restore Constraints
```sql
-- Null out orphaned FK references
UPDATE tags SET claimed_by_andee_id = NULL
  WHERE claimed_by_andee_id IS NOT NULL
  AND claimed_by_andee_id NOT IN (SELECT id FROM andees);
UPDATE tags SET reserved_by_andee_id = NULL
  WHERE reserved_by_andee_id IS NOT NULL
  AND reserved_by_andee_id NOT IN (SELECT id FROM andees);
UPDATE invitations SET accepted_by_andee_id = NULL
  WHERE accepted_by_andee_id IS NOT NULL
  AND accepted_by_andee_id NOT IN (SELECT id FROM andees);

-- Re-add FK constraints
ALTER TABLE tags ADD CONSTRAINT tags_claimed_by_andee_id_andees_id_fk
  FOREIGN KEY (claimed_by_andee_id) REFERENCES andees(id);
ALTER TABLE tags ADD CONSTRAINT tags_reserved_by_andee_id_andees_id_fk
  FOREIGN KEY (reserved_by_andee_id) REFERENCES andees(id);
ALTER TABLE invitations ADD CONSTRAINT invitations_accepted_by_andee_id_andees_id_fk
  FOREIGN KEY (accepted_by_andee_id) REFERENCES andees(id);
ALTER TABLE payments ADD CONSTRAINT payments_andee_id_andees_id_fk
  FOREIGN KEY (andee_id) REFERENCES andees(id);
ALTER TABLE email_logs ADD CONSTRAINT email_logs_andee_id_andees_id_fk
  FOREIGN KEY (andee_id) REFERENCES andees(id);
ALTER TABLE refunds ADD CONSTRAINT refunds_payment_id_payments_id_fk
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE;
```

### Step 9: Verify
```sql
SELECT 'andees' as tbl, count(*) FROM andees
UNION ALL SELECT 'tags', count(*) FROM tags
UNION ALL SELECT 'invitations', count(*) FROM invitations
UNION ALL SELECT 'employees', count(*) FROM employees
UNION ALL SELECT 'payments', count(*) FROM payments
UNION ALL SELECT 'email_logs', count(*) FROM email_logs
UNION ALL SELECT 'app_config', count(*) FROM app_config
ORDER BY tbl;
```

### Step 10: Set up Cloud SQL Studio access for team

Cloud SQL Studio uses IAM database authentication. Each team member needs:
1. A Cloud IAM DB user created on the instance
2. PostgreSQL grants on the `ampersand` database tables

```bash
# Set postgres superuser password (one-time, needed for grants)
gcloud sql users set-password postgres --instance=INSTANCE_NAME --project=PROJECT_ID --password=TEMP_PASSWORD

# For each team member:
gcloud sql users create "email@and.com" --instance=INSTANCE_NAME --project=PROJECT_ID --type=CLOUD_IAM_USER

PGPASSWORD="TEMP_PASSWORD" psql -h 127.0.0.1 -p 5433 -U postgres -d ampersand -c '
GRANT USAGE ON SCHEMA public TO "email@and.com";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "email@and.com";
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "email@and.com";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "email@and.com";
'
```

Also transfer table ownership to `postgres` so Studio explorer shows tables for all users:
```bash
PGPASSWORD="TEMP_PASSWORD" psql -h 127.0.0.1 -p 5433 -U postgres -d ampersand -c "
ALTER TABLE andees OWNER TO postgres;
ALTER TABLE tags OWNER TO postgres;
ALTER TABLE invitations OWNER TO postgres;
ALTER TABLE employees OWNER TO postgres;
ALTER TABLE payments OWNER TO postgres;
ALTER TABLE refunds OWNER TO postgres;
ALTER TABLE email_logs OWNER TO postgres;
ALTER TABLE email_verification_tokens OWNER TO postgres;
ALTER TABLE otps OWNER TO postgres;
ALTER TABLE app_config OWNER TO postgres;
ALTER TABLE rate_limits OWNER TO postgres;
"
```

Then grant the `ampersand` app user full access back (it lost ownership):
```bash
PGPASSWORD="TEMP_PASSWORD" psql -h 127.0.0.1 -p 5433 -U postgres -d ampersand -c '
GRANT ALL ON ALL TABLES IN SCHEMA public TO ampersand;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ampersand;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ampersand;
'
```

**Staging team members configured (2026-03-26):** michael@, aaron@, kevin@, santiago@ (all @and.com)

### Step 11: Deploy Apps
Next CI deploy will pick up `DATABASE_URL` from Secret Manager. Cloud Run services connect via the built-in Cloud SQL Auth Proxy (unix socket).

**Important:** After CI deploys, verify Cloud Run services have the Cloud SQL annotation. If not, run manually for each service:
```bash
gcloud run services update SERVICE_NAME \
  --project=PROJECT_ID \
  --region=us-central1 \
  --set-cloudsql-instances=PROJECT_ID:us-central1:INSTANCE_NAME \
  --update-secrets=DATABASE_URL=database-url-ENVIRONMENT:latest \
  --quiet
```
The `--add-cloudsql-instances` flag on `gcloud run deploy` is silently ignored for v2 services. Once set via `services update`, the annotation persists across new revisions.

**Also verify** web app traffic is promoted to the new revision. Smoke test failures may prevent auto-promotion — manually promote if needed:
```bash
gcloud run services update-traffic web-app \
  --project=PROJECT_ID --region=us-central1 \
  --to-revisions=REVISION_NAME=100
```

### Step 12: Stop Cloud SQL Proxy
```bash
pkill -f cloud-sql-proxy
```

**Note:** Do NOT disable public IP (`--no-assign-ip`). Cloud Run's built-in Auth Proxy requires the Cloud SQL instance to have public IP enabled (it connects via the Cloud SQL Admin API, not the VPC private network). The Terraform module has `ipv4_enabled = true` for this reason.

---

### Gotchas Encountered
1. **Cloud SQL public IP required** — Cloud Run Auth Proxy connects via the public Cloud SQL Admin API, not the VPC. Without `ipv4_enabled = true`, proxy times out on port 3307. Terraform CI reverted this once; now fixed in the module.
2. **postgres.js ignores `?host=` in URLs** — The `client.ts` extracts the Cloud SQL socket path from the URL query param and passes it as the `host` option separately. Format: `postgresql://user:pass@localhost/db?host=/cloudsql/PROJECT:REGION:INSTANCE`
3. **`--add-cloudsql-instances` on `gcloud run deploy` is silently ignored** for v2 services. Must use `gcloud run services update --set-cloudsql-instances` instead. Once set, annotation persists across revisions.
4. **firebase-admin Timestamps** are not `instanceof` client SDK Timestamp — the migration script normalizes them to Unix ms before passing to transformers
5. **drizzle-kit migrate** uses `pg` driver which isn't installed — apply SQL files via psql instead
6. **Entity-owned tags** have `ownerEntityId` pointing to entity IDs (not in andees table) — must null out `claimedByAndeeId` for these or drop FK constraint
7. **41 andee docs skipped** due to duplicate `phone_number` UNIQUE constraint — these are test/legacy accounts with same phone
8. **Cloud SQL Studio sidebar** shows "Tables 0" unless tables are owned by the connecting user. Transfer ownership to `postgres` and grant IAM users explicit permissions.
9. **Web app smoke test failures** prevent auto-promotion of canary revisions. Must manually promote via `gcloud run services update-traffic`.
10. **MCP Dockerfile** must explicitly COPY `packages/db/` (uses tsx at runtime, not Next.js bundler)

### Password Retrieval
```bash
# Get DATABASE_URL (contains password) from Secret Manager
gcloud secrets versions access latest --secret=database-url-ENVIRONMENT --project=PROJECT_ID
```
