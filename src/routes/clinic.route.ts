import { Router } from 'express';
import { authenticateJWT, requireRole } from '../middlewares/auth.middleware';
import { getMyClinic, updateMyClinic } from '../controllers/clinic.controller';

const router = Router();

router.get('/me', authenticateJWT, requireRole(['CLINIC_ADMIN']), getMyClinic);
router.put('/me', authenticateJWT, requireRole(['CLINIC_ADMIN']), updateMyClinic);

export default router;