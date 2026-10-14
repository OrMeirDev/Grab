// Classified lookup/download failures -> the Hebrew label on the queue row.

const ERROR_LABELS = {
  blocked: 'האתר חסם זמנית, נסה שוב מאוחר יותר',
  private: 'הסרטון פרטי או דורש התחברות',
  notfound: 'לא נמצא סרטון בקישור',
  notfoundPage: 'לא נמצא סרטון בקישור, וגם לא בנגן שבתוך העמוד',
  protected: 'הסרטון מוגן בהגנת העתקה (DRM), ואי אפשר להוריד אותו',
  unavailable: 'הסרטון הוסר או לא זמין',
  network: 'אין חיבור לאינטרנט',
  browserContext: 'העמוד פתוח בכמה סשנים של הדפדפן; השאר אותו פתוח בסשן שבו אתה מחובר',
};

export const LOOKUP_FAILED = 'לא נמצא סרטון בקישור';
export const DOWNLOAD_FAILED = 'ההורדה נכשלה';

export const errorLabel = (kind, fallback, browser) => (kind === 'browserContext' && browser
  ? `העמוד פתוח בכמה סשנים של ${browser.name}; השאר אותו פתוח בסשן שבו אתה מחובר`
  : ERROR_LABELS[kind] || fallback);
