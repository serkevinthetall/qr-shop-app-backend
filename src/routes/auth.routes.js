import express from "express";
import { login, me, logout, changePassword } from "../controllers/auth.controller.js";

const router = express.Router();

router.post("/login", login);
router.get("/me", me);
router.post("/logout", logout);
router.post("/change-password", changePassword);

export default router;