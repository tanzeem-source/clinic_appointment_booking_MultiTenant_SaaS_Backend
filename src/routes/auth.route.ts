import { Router } from 'express';
import { registerPatient, registerClinic, verifyOTP } from 'controllers/auth.controller';

const router = Router();

router.post('/register-patient', registerPatient);
router.post('/register-clinic', registerClinic);
router.post('/verify-otp', verifyOTP);

export default router;