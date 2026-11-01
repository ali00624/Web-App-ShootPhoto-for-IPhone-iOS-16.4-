// Настройки подключения к Supabase — ОСНОВНОЙ проект (stwjltiylgqynnoyrezc).
// Здесь ПУБЛИЧНЫЙ ключ (publishable) — он специально лежит в коде сайта.
// НЕ вставляй сюда service_role / secret ключ!
window.APP_CONFIG = {
  SUPABASE_URL: "https://stwjltiylgqynnoyrezc.supabase.co",
  SUPABASE_KEY: "sb_publishable_LQ0YSzmQZKA3kWWZbIwzwQ_of560XGH",
  // Имя bucket в Storage (регистр важен: photos ≠ Photos)
  SUPABASE_BUCKET: "photos",
  // true  — фото в папке по uid: каждый видит только своё (нужно для защиты)
  // false — фото в корне bucket (небезопасно, не использовать)
  USE_UID_FOLDERS: true
};
