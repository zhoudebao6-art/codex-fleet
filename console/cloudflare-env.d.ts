declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    FLEET_OWNER_EMAIL?: string;
    FLEET_ADMIN_TOKEN?: string;
  }
}
