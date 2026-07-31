import express from "express";
import {
  getProducts,
  getProductById,
  getCategories,
  searchProducts,
  getProductImage,
  debugPricelist,
} from "../controllers/product.controller.js";

const router = express.Router();

router.get("/debug/pricelist", debugPricelist);
router.get("/products/search", searchProducts);
router.get("/products/:id/image", getProductImage);
router.get("/products/:id", getProductById);
router.get("/products", getProducts);
router.get("/categories", getCategories);

export default router;