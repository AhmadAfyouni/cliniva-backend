import { BilingualMessage } from '../types/response.types';
import { AuthErrorCode } from '../enums/auth-error-code.enum';

/**
 * Bilingual error messages for authentication errors
 * Supports both Arabic (ar) and English (en)
 */
export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, BilingualMessage> = {
  [AuthErrorCode.INVALID_CREDENTIALS]: {
    ar: 'اسم المستخدم أو كلمة المرور غير صحيحة. يرجى المحاولة مرة أخرى.',
    en: 'Incorrect Username or password. Please try again',
  },
  [AuthErrorCode.TOKEN_EXPIRED]: {
    ar: 'انتهت صلاحية الجلسة. يرجى تسجيل الدخول مرة أخرى.',
    en: 'Your session has expired. Please log in again',
  },
  [AuthErrorCode.TOKEN_INVALID]: {
    ar: 'رمز غير صالح',
    en: 'Invalid token',
  },
  [AuthErrorCode.USER_NOT_FOUND]: {
    ar: 'اسم المستخدم هذا غير مسجل في النظام.',
    en: 'This Username is not registered in the system',
  },
  [AuthErrorCode.EMAIL_NOT_VERIFIED]: {
    ar: 'البريد الإلكتروني غير مؤكد',
    en: 'Email not verified',
  },
  [AuthErrorCode.ACCOUNT_DEACTIVATED]: {
    ar: 'حسابك غير نشط حالياً. يرجى التواصل مع مسؤول النظام للحصول على المساعدة.',
    en: 'Your account is currently inactive. Please contact the system administrator for assistance.',
  },
  [AuthErrorCode.PASSWORD_RESET_TOKEN_INVALID]: {
    ar: 'رمز إعادة تعيين كلمة المرور غير صالح',
    en: 'Password reset token invalid',
  },
  [AuthErrorCode.PASSWORD_RESET_TOKEN_EXPIRED]: {
    ar: 'انتهت صلاحية رمز إعادة تعيين كلمة المرور',
    en: 'Password reset token expired',
  },
  [AuthErrorCode.PASSWORD_CHANGE_REQUIRED]: {
    ar: 'يجب تغيير كلمة المرور',
    en: 'Password change required',
  },
  [AuthErrorCode.NEW_PASSWORD_SAME_AS_CURRENT]: {
    ar: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية',
    en: 'New password must differ from current password',
  },
  [AuthErrorCode.RATE_LIMIT_EXCEEDED]: {
    ar: 'لقد أرسلت طلبات كثيرة. يرجى الانتظار قبل المحاولة مرة أخرى',
    en: 'Too many attempts. Please wait before trying again',
  },
  [AuthErrorCode.TOKEN_BLACKLISTED]: {
    ar: 'تم إنهاء جلستك لأن معلومات أساسية في حسابك تم تعديلها. يرجى تسجيل الدخول مرة أخرى باستخدام البيانات المحدثة.',
    en: 'Your session has ended because essential account information was updated. Please log in again using your updated credentials.',
  },
  [AuthErrorCode.PASSWORDS_DO_NOT_MATCH]: {
    ar: 'كلمات المرور غير متطابقة',
    en: 'Passwords do not match',
  },
  [AuthErrorCode.WEAK_PASSWORD]: {
    ar: 'كلمة المرور ضعيفة جداً',
    en: 'Password too weak',
  },
};

/**
 * Success messages for authentication operations
 */
export const AUTH_SUCCESS_MESSAGES = {
  LOGIN_SUCCESS: {
    ar: 'تم تسجيل الدخول بنجاح.',
    en: 'Logged in successfully',
  },
  LOGOUT_SUCCESS: {
    ar: 'تم تسجيل الخروج بنجاح.',
    en: 'Logged out successfully',
  },
  PASSWORD_CHANGED: {
    ar: 'تم تغيير كلمة المرور بنجاح',
    en: 'Password changed successfully',
  },
  PASSWORD_RESET_EMAIL_SENT: {
    ar: 'تم إرسال رابط إعادة تعيين كلمة المرور إلى بريدك الإلكتروني',
    en: 'Password reset link sent to your email',
  },
  PASSWORD_RESET_SUCCESS: {
    ar: 'تم إعادة تعيين كلمة المرور بنجاح',
    en: 'Password reset successful',
  },
  TOKEN_REFRESHED: {
    ar: 'تم تحديث الرمز بنجاح',
    en: 'Token refreshed successfully',
  },
  FIRST_LOGIN_PASSWORD_CHANGED: {
    ar: 'تم تغيير كلمة المرور الأولية بنجاح',
    en: 'Initial password changed successfully',
  },
} as const;
