// Classified lookup/download failures -> the Hebrew label on the queue row.

const ERROR_LABELS = {
  forbidden: 'השרת סירב לבקשת הסרטון (403); נסה לזהות אותו מחדש מהעמוד',
  notmedia: 'המקור שהתקבל אינו קובץ וידאו או אודיו תקין',
  verification: 'לא ניתן לבדוק את תקינות הקובץ שהתקבל',
  browserUnavailable: 'הדפדפן שנבחר לא מותקן במחשב',
  extensionNotConnected: 'ההרחבה של Grab לא מחוברת בדפדפן',
  hostSetupError: 'יש בעיה בהתקנת החיבור לדפדפן',
  wrongProfile: 'הפרופיל שנבחר בדפדפן לא מחובר',
  browserChoice: 'כמה פרופילים מחוברים: בחר באיזה להשתמש',
  videoChoice: 'נמצאו כמה סרטונים בעמוד: בחר את הנכון',
  videoChoiceExpired: 'בחירת הסרטון פגה. נסה שוב לזיהוי מחדש',
  playbackRequired: 'צריך ללחוץ Play בדפדפן כדי לזהות את הסרטון',
  noVideoBrowser: 'לא נמצא סרטון בעמוד שנפתח בדפדפן',
  browserDisconnected: 'הדפדפן התנתק באמצע הזיהוי; נסה שוב',
  discoveryTimeout: 'הזיהוי בדפדפן לקח יותר מדי זמן',
  tabFailed: 'לא הצלחתי לפתוח את העמוד בדפדפן',
  extensionError: 'שגיאה בהרחבה של Grab בדפדפן',
  extensionPermission: 'ההרחבה לא קיבלה הרשאה לעמוד הזה',
  sessionExpired: 'ההתחברות לאתר פגה: היכנס שוב בדפדפן ונסה שוב',
  engineFailure: 'הסרטון נמצא, אבל מנוע ההורדות לא הצליח להשתמש בו',
  probeTimeout: 'בדיקת המקור לקחה יותר מדי זמן',
  stalled: 'ההורדה נתקעה ללא התקדמות',
  cancelled: 'בוטל',

  blocked: 'האתר חסם זמנית, נסה שוב מאוחר יותר',
  rateLimited: 'האתר חסם זמנית, נסה שוב מאוחר יותר',
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

export const errorLabel = (kind, fallback, browser) => {
  if (kind === 'browserContext' && browser) return `העמוד פתוח בכמה סשנים של ${browser.name}; השאר אותו פתוח בסשן שבו אתה מחובר`;
  // A site that needs the user's browser session, while that browser can't be reached.
  if (kind === 'sessionRequired') return `האתר דורש את ${browser?.name || 'הדפדפן'} שבו אתה מחובר. פתח אותו, אשר את החיבור ונסה שוב`;
  return ERROR_LABELS[kind] || fallback;
};
