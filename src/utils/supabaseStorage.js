function getStorageConfig() {
  let url = process.env.SUPABASE_URL;
  if (!url && process.env.DATABASE_URL) {
    try {
      const host = new URL(process.env.DATABASE_URL).hostname;
      const match = host.match(/^db\.([^.]+)\.supabase\.co$/);
      if (match) url = 'https://' + match[1] + '.supabase.co';
    } catch (_) {}
  }
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const isModernSecret = key.startsWith('sb_secret_');
  const isLegacyServiceRole = key.startsWith('eyJ') && key.split('.').length === 3;
  if (!isModernSecret && !isLegacyServiceRole) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    url = parsed.origin;
  } catch (_) { return null; }
  return { url, key, isModernSecret };
}

function storageAuthHeaders(config, extra = {}) {
  const headers = { apikey: config.key, ...extra };
  if (!config.isModernSecret) headers.Authorization = 'Bearer ' + config.key;
  return headers;
}

module.exports = { getStorageConfig, storageAuthHeaders };
