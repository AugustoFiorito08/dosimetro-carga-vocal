// Deployment settings of the app (odd/tasks/base-por-roles.md, T2; decision 2026-11-27: kept in
// the app, not typed on each device). The public key is meant to be in the page: what protects
// the data are the database rules (supabase/schema.sql). Never put a secret key here.
export const APP_CONFIG = Object.freeze({
  /** Supabase project of the study. */
  supabaseUrl: 'https://kokqkekchsbeztkpnctm.supabase.co',
  /** Its public key (Project Settings > API Keys: publishable or anon). Empty: sign-in disabled. */
  supabaseAnonKey: '',
});
