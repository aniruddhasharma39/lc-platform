import { Router } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { prisma } from '../lib/prisma';
import { authenticate, requireModule } from '../middleware/auth';
import { z } from 'zod';

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

// Public: Get Branding
const getBrandingHandler = async (req: any, res: any, next: any) => {
  try {
    const appName = await prisma.appSetting.findUnique({ where: { key: 'APP_NAME' } });
    const wallpaper = await prisma.appSetting.findUnique({ where: { key: 'WALLPAPER_URL' } });
    const gradient = await prisma.appSetting.findUnique({ where: { key: 'LOGIN_GRADIENT' } });
    
    res.json({
      appName: appName?.value || 'LC Platform',
      wallpaperUrl: wallpaper?.value || null,
      logoUrl: wallpaper?.value || null,
      loginGradient: gradient?.value || 'linear-gradient(135deg, #0b3c7a 0%, #0e9aa7 100%)'
    });
  } catch (error) {
    console.warn('Database momentarily unreachable for branding, returning default configuration:', error);
    res.json({
      appName: 'LC Platform',
      wallpaperUrl: null,
      logoUrl: null,
      loginGradient: 'linear-gradient(135deg, #0b3c7a 0%, #0e9aa7 100%)'
    });
  }
};

router.get('/branding', getBrandingHandler);
router.get('/', getBrandingHandler);

// Admin: Update Branding
const updateBrandingSchema = z.object({
  appName: z.string().optional(),
  loginGradient: z.string().optional(),
});

router.put('/branding', authenticate, requireModule('branding'), upload.single('wallpaper'), async (req, res, next) => {
  try {
    let wallpaperUrl = null;
    
    if (req.file) {
      // Upload to Cloudinary using memory buffer stream
      wallpaperUrl = await new Promise<string>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'lc-platform' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result!.secure_url);
          }
        );
        stream.end(req.file!.buffer);
      });
    }

    const { appName, loginGradient } = req.body;

    await prisma.$transaction(async (tx) => {
      if (appName) {
        await tx.appSetting.upsert({
          where: { key: 'APP_NAME' },
          update: { value: appName },
          create: { key: 'APP_NAME', value: appName }
        });
      }
      
      if (wallpaperUrl) {
        await tx.appSetting.upsert({
          where: { key: 'WALLPAPER_URL' },
          update: { value: wallpaperUrl },
          create: { key: 'WALLPAPER_URL', value: wallpaperUrl }
        });
      }

      if (loginGradient) {
        await tx.appSetting.upsert({
          where: { key: 'LOGIN_GRADIENT' },
          update: { value: loginGradient },
          create: { key: 'LOGIN_GRADIENT', value: loginGradient }
        });
      }
    });

    const updatedAppName = await prisma.appSetting.findUnique({ where: { key: 'APP_NAME' } });
    const updatedWallpaper = await prisma.appSetting.findUnique({ where: { key: 'WALLPAPER_URL' } });
    const updatedGradient = await prisma.appSetting.findUnique({ where: { key: 'LOGIN_GRADIENT' } });

    res.json({
      appName: updatedAppName?.value || 'LC Platform',
      wallpaperUrl: updatedWallpaper?.value || null,
      logoUrl: updatedWallpaper?.value || null,
      loginGradient: updatedGradient?.value || 'linear-gradient(135deg, #0b3c7a 0%, #0e9aa7 100%)'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
