import { Router } from "express";
import { authenticateJWT, requireRole } from "../middlewares/auth.middleware";
import {
  getMyProfile,
  updateMyProfile,
} from "../controllers/patient.controller";

const router = Router();

router.get("/me", authenticateJWT, requireRole(["PATIENT"]), getMyProfile);
router.put("/me", authenticateJWT, requireRole(["PATIENT"]), updateMyProfile);

export default router;
