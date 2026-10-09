import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Jimp, loadFont } from 'jimp';
import { SANS_16_WHITE, SANS_16_BLACK } from 'jimp/fonts';

const router = Router();

const uploadSchema = z.object({
  masterId: z.number(),
  childDeviceId: z.number().optional(),
  category: z.enum(['MASTER', 'DEVICE_1', 'DEVICE_2', 'POWER_SOURCE']),
  imageBase64: z.string(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

// Upload evidence
router.post('/', authenticate, async (req: any, res, next) => {
  try {
    const data = uploadSchema.parse(req.body);

    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Process base64 string
    // Format is usually "data:image/jpeg;base64,/9j/4AAQ..."
    const matches = data.imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    let buffer: Buffer;
    let extension = 'jpg';

    if (matches && matches.length === 3) {
      const mimeType = matches[1];
      buffer = Buffer.from(matches[2], 'base64');
      if (mimeType.includes('png')) extension = 'png';
    } else {
      buffer = Buffer.from(data.imageBase64, 'base64');
    }

    // Load the image with Jimp
    const image = await Jimp.read(buffer);
    
    // Create watermark text
    const dateStr = new Date().toLocaleString();
    const latStr = data.latitude !== undefined ? data.latitude.toFixed(6) : 'Unknown';
    const lngStr = data.longitude !== undefined ? data.longitude.toFixed(6) : 'Unknown';
    const text = `Lat: ${latStr} | Lng: ${lngStr} | ${dateStr}`;

    // Load fonts (both black and white to simulate an outline/shadow for readability)
    const fontWhite = await loadFont(SANS_16_WHITE);
    const fontBlack = await loadFont(SANS_16_BLACK);

    // Print black text offset by 1px as a shadow, then white text on top
    image.print({ font: fontBlack, x: 11, y: 11, text });
    image.print({ font: fontWhite, x: 10, y: 10, text });

    const stampedBuffer = await image.getBuffer('image/jpeg');

    const filename = `${crypto.randomUUID()}.jpg`;
    const filepath = path.join(uploadsDir, filename);

    fs.writeFileSync(filepath, stampedBuffer);

    const evidence = await prisma.installationEvidence.create({
      data: {
        category: data.category,
        imageUrl: `/uploads/${filename}`,
        latitude: data.latitude,
        longitude: data.longitude,
        userId: req.user.id,
        masterId: data.masterId,
        childDeviceId: data.childDeviceId,
      },
    });

    res.status(201).json(evidence);
  } catch (error) {
    next(error);
  }
});

export default router;
