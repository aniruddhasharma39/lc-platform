import { Router } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { prisma } from '../lib/prisma';
import { authenticate, requireModule } from '../middleware/auth';
import { z } from 'zod';

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dixdw1mus',
  api_key: process.env.CLOUDINARY_API_KEY || '647788876868715',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'Aku2U6rp22oHgQQEESnZ7w3YaUI'
});

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

// Public: Get Branding
router.get('/branding', async (req, res, next) => {
  try {
    const appName = await prisma.appSetting.findUnique({ where: { key: 'APP_NAME' } });
    const wallpaper = await prisma.appSetting.findUnique({ where: { key: 'WALLPAPER_URL' } });
    
    res.json({
      appName: appName?.value || 'LC Platform',
      wallpaperUrl: wallpaper?.value || null
    });
  } catch (error) {
    next(error);
  }
});

// Admin: Update Branding
const updateBrandingSchema = z.object({
  appName: z.string().optional(),
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

    const { appName } = req.body;

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
    });

    const updatedAppName = await prisma.appSetting.findUnique({ where: { key: 'APP_NAME' } });
    const updatedWallpaper = await prisma.appSetting.findUnique({ where: { key: 'WALLPAPER_URL' } });

    res.json({
      appName: updatedAppName?.value || 'LC Platform',
      wallpaperUrl: updatedWallpaper?.value || null
    });
  } catch (error) {
    next(error);
  }
});

export default router;
