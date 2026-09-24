import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { registerPatient, registerClinic, verifyOTP, resendOtp, login, logout} from '../controllers/auth.controller';

const router = Router();

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

router.post('/register-patient', authLimiter, registerPatient);
router.post('/register-clinic', authLimiter, registerClinic);
router.post('/verify-otp', otpLimiter, verifyOTP);
router.post('/resend-otp', otpLimiter, resendOtp);
router.post('/login', authLimiter, login);
router.post('/logout', logout);

export default router;