import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import zh from './locales/zh.json';
import ar from './locales/ar.json';

const resources = {
  en: { translation: en },
  zh: { translation: zh },
  ar: { translation: ar },
};

/** RTL 语言列表 */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

export function isRtl(lng: string): boolean {
  const base = lng.split('-')[0].toLowerCase();
  return RTL_LANGUAGES.has(base);
}

export function getDir(lng: string): 'rtl' | 'ltr' {
  return isRtl(lng) ? 'rtl' : 'ltr';
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh', 'ar'],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
    },
  });

// 语言变化时更新 html lang 和 dir 属性
function applyHtmlDirection(lng: string) {
  document.documentElement.lang = lng;
  document.documentElement.dir = getDir(lng);
}
i18n.on('languageChanged', applyHtmlDirection);
i18n.on('initialized', () => applyHtmlDirection(i18n.language));

export default i18n;
