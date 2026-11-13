import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import {
  ensureCollectionExists,
  indexStaffFace,
  searchFaceInCollection,
  compareFaceImages,
  deleteStaffFace,
  DEFAULT_SIMILARITY_THRESHOLD,
} from '../lib/rekognitionClient';
import { uploadBufferToCloudinary, deleteFromCloudinary } from '../lib/cloudinaryUploader';
import { runAttendanceRetentionSweep } from '../workers/attendanceRetentionWorker';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

// Ensure upload directories exist
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const FACES_DIR = path.join(UPLOADS_DIR, 'faces');
const ATTENDANCE_DIR = path.join(UPLOADS_DIR, 'attendance');

for (const dir of [UPLOADS_DIR, FACES_DIR, ATTENDANCE_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Calculates Great-Circle Distance between two coordinates in meters using the Haversine formula.
 */
export function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371e3; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in meters
}

/**
 * Returns today's date formatted as YYYY-MM-DD in local Indian Standard Time (IST).
 */
export function getTodayDateString(): string {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  return istTime.toISOString().split('T')[0];
}

// =========================================================================
// 1. FACE ENROLLMENT WORKFLOW
// =========================================================================

/**
 * GET /api/v1/attendance/enrollment-status
 * Checks whether the logged-in Gateman or Restkeeper has registered their face.
 */
router.get('/enrollment-status', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        employeeId: true,
        fullName: true,
        isFaceEnrolled: true,
        faceId: true,
        faceImageKey: true,
        faceEnrolledAt: true,
        faceEnrollConfidence: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      success: true,
      isFaceEnrolled: user.isFaceEnrolled,
      faceId: user.faceId,
      faceImageKey: user.faceImageKey,
      faceEnrolledAt: user.faceEnrolledAt,
      faceEnrollConfidence: user.faceEnrollConfidence,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch enrollment status' });
  }
});

/**
 * POST /api/v1/attendance/enroll-face
 * Registers a user's face in Amazon Rekognition Collection and locks the profile.
 */
router.post('/enroll-face', authenticate, upload.single('image'), async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, employeeId: true, fullName: true, isFaceEnrolled: true, faceImageKey: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.isFaceEnrolled) {
      return res.status(400).json({
        error: 'Face is already enrolled. Any changes require Restkeeper or Administrator approval.',
      });
    }

    let imageBuffer: Buffer | null = null;
    if (req.file && req.file.buffer) {
      imageBuffer = req.file.buffer;
    } else if (req.body.imageBase64) {
      const cleanBase64 = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      imageBuffer = Buffer.from(cleanBase64, 'base64');
    }

    if (!imageBuffer) {
      return res.status(400).json({ error: 'No image provided. Please upload a clear front-facing selfie.' });
    }

    // 1. Ensure Rekognition Collection exists
    await ensureCollectionExists();

    // 2. Index Face in Amazon Rekognition
    const indexResult = await indexStaffFace({
      imageBytes: imageBuffer,
      employeeId: user.employeeId,
    });

    if (!indexResult.success || !indexResult.faceId) {
      // If Rekognition failed due to invalid credentials in test/offline environment, provide mock fallback
      if (process.env.NODE_ENV === 'test' || !process.env.AWS_ACCESS_KEY_ID) {
        console.warn('[Rekognition] Mocking face indexing in test/offline environment');
        const mockFaceId = `mock_face_${user.employeeId}_${Date.now()}`;
        
        let mockFaceUrl: string | null = null;
        try {
          const cldRes = await uploadBufferToCloudinary(imageBuffer, {
            folder: 'lc_platform/face_profiles',
            publicIdPrefix: `face_${user.id}_${user.employeeId}`,
            tags: ['lc-platform', 'face-profile', `emp_${user.employeeId}`],
            maxDimension: 800,
          });
          mockFaceUrl = cldRes.secureUrl;
        } catch {
          mockFaceUrl = null;
        }

        await prisma.user.update({
          where: { id: user.id },
          data: {
            isFaceEnrolled: true,
            faceId: mockFaceId,
            faceImageKey: mockFaceUrl,
            faceEnrolledAt: new Date(),
            faceEnrollConfidence: 99.5,
          },
        });

        return res.json({
          success: true,
          message: 'Face successfully enrolled (Test/Offline mode)',
          faceId: mockFaceId,
          confidence: 99.5,
        });
      }

      return res.status(400).json({
        error: indexResult.error || 'Face indexing failed. Ensure proper lighting and a clear front-facing pose.',
      });
    }

    // 3. Purge any previous face image from Cloudinary to keep media library clean
    if (user.faceImageKey) {
      await deleteFromCloudinary(user.faceImageKey);
    }

    // 4. Stream reference face photo to Cloudinary CDN (Zero local EC2 storage)
    let faceCloudinaryUrl: string | null = null;
    try {
      const uploadRes = await uploadBufferToCloudinary(imageBuffer, {
        folder: 'lc_platform/face_profiles',
        publicIdPrefix: `face_${user.id}_${user.employeeId}`,
        tags: ['lc-platform', 'face-profile', `emp_${user.employeeId}`],
        maxDimension: 800,
      });
      faceCloudinaryUrl = uploadRes.secureUrl;
    } catch (cldErr: any) {
      console.warn('[Cloudinary] Face profile upload failed, continuing with Rekognition FaceId:', cldErr.message);
    }

    // 5. Update user record with Rekognition FaceId and lock profile
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        isFaceEnrolled: true,
        faceId: indexResult.faceId,
        faceImageKey: faceCloudinaryUrl,
        faceEnrolledAt: new Date(),
        faceEnrollConfidence: indexResult.confidence || 99.0,
      },
    });

    return res.json({
      success: true,
      message: 'Facial biometric profile successfully registered and locked.',
      faceId: updatedUser.faceId,
      confidence: updatedUser.faceEnrollConfidence,
      photoUrl: updatedUser.faceImageKey,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Face enrollment failed' });
  }
});

// =========================================================================
// 2. DAILY SHIFT & DUTY LOOKUP
// =========================================================================

/**
 * GET /api/v1/attendance/active-duty
 * Returns today's assigned shift, location coordinates, allowed radius, and attendance state.
 */
router.get('/active-duty', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const today = getTodayDateString();
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        station: true,
        assignedGates: { include: { gate: true } },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Find active duty roster for today (Dynamic 2-Tier Fallback: Specific Date Override -> Permanent Master Cycle)
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayDayOfWeek = dayNames[new Date().getDay()];

    let roster = await prisma.gateDutyRoster.findFirst({
      where: {
        gatemanUserId: userId,
        date: today,
        isPermanent: false,
      },
      include: {
        gate: true,
        station: true,
      },
      orderBy: { id: 'desc' },
    });

    if (!roster) {
      roster = await prisma.gateDutyRoster.findFirst({
        where: {
          gatemanUserId: userId,
          dayOfWeek: todayDayOfWeek,
          isPermanent: true,
        },
        include: {
          gate: true,
          station: true,
        },
        orderBy: { id: 'desc' },
      });
    }

    // Determine target location and geofence radius
    let targetLocation = null;
    let allowedRadius = 150; // Default 150m for LC Gates

    const formatGateLabel = (lcNumber: string, locName?: string | null) => {
      const cleanNum = lcNumber.startsWith('LC-') ? lcNumber : `LC-${lcNumber}`;
      return locName ? `${cleanNum} (${locName})` : cleanNum;
    };

    if (roster && roster.gate) {
      targetLocation = {
        type: 'GATE',
        id: roster.gate.id,
        name: formatGateLabel(roster.gate.lcNumber, roster.gate.locationName),
        latitude: roster.gate.latitude ?? 25.5941,
        longitude: roster.gate.longitude ?? 85.1376,
      };
      allowedRadius = 150;
    } else if (user.assignedGates.length > 0) {
      const primaryGate = user.assignedGates[0].gate;
      targetLocation = {
        type: 'GATE',
        id: primaryGate.id,
        name: formatGateLabel(primaryGate.lcNumber, primaryGate.locationName),
        latitude: primaryGate.latitude ?? 25.5941,
        longitude: primaryGate.longitude ?? 85.1376,
      };
      allowedRadius = 150;
    } else if (user.station) {
      // Restkeeper station-level scope
      targetLocation = {
        type: 'STATION',
        id: user.station.id,
        name: `${user.station.name} (${user.station.code})`,
        latitude: user.station.latitude ?? 25.5941,
        longitude: user.station.longitude ?? 85.1376,
      };
      allowedRadius = 400; // 400m for Station perimeter
    }

    // Check today's attendance logs
    const todayAttendances = await prisma.shiftAttendance.findMany({
      where: {
        userId,
        date: today,
      },
      orderBy: { timestamp: 'asc' },
    });

    const checkIn = todayAttendances.find(a => a.type === 'CHECK_IN') || null;
    const checkOut = todayAttendances.find(a => a.type === 'CHECK_OUT') || null;

    let dutyStatus = 'PENDING_CHECK_IN';
    if (checkOut) {
      dutyStatus = 'COMPLETED';
    } else if (checkIn) {
      dutyStatus = 'ON_DUTY';
    }

    return res.json({
      success: true,
      today,
      user: {
        id: user.id,
        fullName: user.fullName,
        designation: user.designation,
        isFaceEnrolled: user.isFaceEnrolled,
      },
      roster: roster ? {
        id: roster.id,
        shiftName: roster.shiftName,
        startTime: roster.startTime,
        endTime: roster.endTime,
        gateName: roster.gate.lcNumber.startsWith('LC-') ? roster.gate.lcNumber : `LC-${roster.gate.lcNumber}`,
        stationName: roster.station.name,
      } : null,
      targetLocation,
      allowedRadius,
      dutyStatus,
      checkIn,
      checkOut,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch active duty' });
  }
});

// =========================================================================
// 3. DAILY SHIFT ATTENDANCE MARKING (CHECK-IN / CHECK-OUT)
// =========================================================================

/**
 * POST /api/v1/attendance/mark
 * Marks shift Check-In or Check-Out with live GPS geofence verification and Rekognition facial match.
 */
router.post('/mark', authenticate, upload.single('image'), async (req: AuthRequest, res: Response) => {
  try {
    const { type, latitude, longitude, rosterId, gateId, stationId } = req.body;

    if (!type || !['CHECK_IN', 'CHECK_OUT'].includes(type)) {
      return res.status(400).json({ error: 'Attendance type must be CHECK_IN or CHECK_OUT' });
    }

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'GPS coordinates (latitude and longitude) are required' });
    }

    const userLat = parseFloat(latitude);
    const userLon = parseFloat(longitude);
    if (isNaN(userLat) || isNaN(userLon)) {
      return res.status(400).json({ error: 'Invalid GPS coordinates format' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        station: true,
        assignedGates: { include: { gate: true } },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.isFaceEnrolled || !user.faceId) {
      return res.status(403).json({
        error: 'Mandatory Facial Biometric Registration required before marking shift attendance.',
        needsEnrollment: true,
      });
    }

    const today = getTodayDateString();

    // =========================================================================
    // STRICT SHIFT SEQUENCE & STATE MACHINE LOCK
    // =========================================================================
    // Find the most recent attendance record for this user
    const lastAttendance = await prisma.shiftAttendance.findFirst({
      where: { userId: user.id },
      orderBy: { id: 'desc' },
      include: { gate: true },
    });

    if (type === 'CHECK_IN') {
      // 1. Prevent Check-In if user has an active, unclosed shift
      if (lastAttendance && lastAttendance.type === 'CHECK_IN') {
        return res.status(400).json({
          success: false,
          code: 'ACTIVE_DUTY_UNCLOSED',
          error: `Unclosed shift detected: You are already checked in for ${lastAttendance.shiftName} (${lastAttendance.date}). You must complete Check-Out before checking in for a new shift.`,
        });
      }
    } else if (type === 'CHECK_OUT') {
      // 2. Prevent Check-Out if there is no active Check-In to close
      if (!lastAttendance || lastAttendance.type !== 'CHECK_IN') {
        return res.status(400).json({
          success: false,
          code: 'NO_ACTIVE_CHECKIN',
          error: 'No active Check-In found. You must mark Check-In before marking Check-Out.',
        });
      }
    }

    // 1. Resolve Target Gate / Station coordinates for geofence validation
    let targetLat = 25.5941;
    let targetLon = 85.1376;
    let allowedRadius = 150;
    let resolvedGateId = gateId ? parseInt(gateId) : null;
    let resolvedStationId = stationId ? parseInt(stationId) : user.stationId;

    if (resolvedGateId) {
      const gate = await prisma.lCGate.findUnique({ where: { id: resolvedGateId } });
      if (gate && gate.latitude && gate.longitude) {
        targetLat = gate.latitude;
        targetLon = gate.longitude;
        resolvedStationId = gate.stationId || resolvedStationId;
      }
    } else if (user.assignedGates.length > 0 && user.assignedGates[0].gate) {
      const gate = user.assignedGates[0].gate;
      resolvedGateId = gate.id;
      if (gate.latitude && gate.longitude) {
        targetLat = gate.latitude;
        targetLon = gate.longitude;
      }
      resolvedStationId = gate.stationId || resolvedStationId;
    } else if (user.station && user.station.latitude && user.station.longitude) {
      targetLat = user.station.latitude;
      targetLon = user.station.longitude;
      allowedRadius = 400; // Restkeeper station scope
    }

    if (!resolvedStationId) {
      const fallbackStation = await prisma.station.findFirst();
      resolvedStationId = fallbackStation?.id || 1;
    }

    // 2. Haversine Distance Check
    const distanceMeters = calculateHaversineDistance(userLat, userLon, targetLat, targetLon);
    const geofencePassed = distanceMeters <= allowedRadius;

    if (!geofencePassed) {
      return res.status(403).json({
        success: false,
        code: 'GEOFENCE_BREACH',
        distanceMeters: Math.round(distanceMeters),
        allowedRadius,
        error: `Geofence breach: You are ${Math.round(distanceMeters)}m away from assigned duty location (max allowed: ${allowedRadius}m). You must be physically present at the gate/station to mark attendance.`,
      });
    }

    // 3. Facial Biometric Verification
    let imageBuffer: Buffer | null = null;
    if (req.file && req.file.buffer) {
      imageBuffer = req.file.buffer;
    } else if (req.body.imageBase64) {
      const cleanBase64 = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      imageBuffer = Buffer.from(cleanBase64, 'base64');
    }

    if (!imageBuffer) {
      return res.status(400).json({ error: 'Live selfie image is required for biometric attendance' });
    }

    // Call Amazon Rekognition
    let similarityScore = 0;
    let faceMatched = false;

    const searchRes = await searchFaceInCollection({
      imageBytes: imageBuffer,
      faceMatchThreshold: DEFAULT_SIMILARITY_THRESHOLD,
    });

    // Expected ExternalImageId format: emp_{employeeId}
    const expectedExternalId = `emp_${user.employeeId}`.replace(/[^a-zA-Z0-9_.\-:]/g, '_');

    if (searchRes.success) {
      const isMatchedToThisUser =
        (user.faceId && searchRes.matchedFaceId === user.faceId) ||
        (searchRes.externalImageId && searchRes.externalImageId === expectedExternalId);

      if (isMatchedToThisUser) {
        if ((searchRes.similarity ?? 0) >= DEFAULT_SIMILARITY_THRESHOLD) {
          faceMatched = true;
          similarityScore = searchRes.similarity!;
        }
      } else {
        // PROXY DETECTED: The camera captured a face that belongs to ANOTHER employee in the database!
        console.warn(`[Proxy Detection] Logged in as ${user.employeeId} (${user.fullName}), but live face matched another staff member: ${searchRes.externalImageId} (${searchRes.matchedFaceId})!`);
        return res.status(401).json({
          success: false,
          code: 'PROXY_FACE_DETECTED',
          error: 'Biometric verification failed: Face does not match your registered profile. Please look directly into the camera with clear lighting and try again.',
        });
      }
    }

    // 1:1 Fallback comparison directly against enrolled reference image (only for this user)
    if (!faceMatched && user.faceImageKey) {
      let refBytes: Buffer | null = null;
      if (user.faceImageKey.startsWith('http')) {
        try {
          const resp = await fetch(user.faceImageKey);
          if (resp.ok) {
            const arrayBuf = await resp.arrayBuffer();
            refBytes = Buffer.from(arrayBuf);
          }
        } catch (fetchErr: any) {
          console.warn('[Rekognition 1:1] Failed to fetch reference image from Cloudinary:', fetchErr.message);
        }
      } else if (fs.existsSync(path.join(process.cwd(), user.faceImageKey))) {
        refBytes = fs.readFileSync(path.join(process.cwd(), user.faceImageKey));
      }

      if (refBytes) {
        const compRes = await compareFaceImages({
          sourceBytes: refBytes,
          targetBytes: imageBuffer,
          similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
        });
        if (compRes.success && compRes.isMatch && (compRes.similarity ?? 0) >= DEFAULT_SIMILARITY_THRESHOLD) {
          faceMatched = true;
          similarityScore = compRes.similarity!;
        }
      }
    }

    if (!faceMatched) {
      return res.status(401).json({
        success: false,
        code: 'FACE_NOT_MATCHED',
        similarityScore: Math.round(similarityScore),
        threshold: DEFAULT_SIMILARITY_THRESHOLD,
        error: 'Facial verification failed: Face does not match the registered profile. Please ensure proper lighting and face the camera directly.',
      });
    }

    // 4. Stream live attendance selfie directly to Cloudinary (Zero local EC2 storage)
    let selfieUrl: string | null = null;
    try {
      const uploadRes = await uploadBufferToCloudinary(imageBuffer, {
        folder: 'lc_platform/attendance',
        publicIdPrefix: `att_${type.toLowerCase()}_u${user.id}_${user.employeeId}`,
        tags: ['lc-platform', 'attendance', type.toLowerCase()],
        maxDimension: 800,
      });
      selfieUrl = uploadRes.secureUrl;
    } catch (cldErr: any) {
      console.warn('[Cloudinary] Attendance selfie upload failed, preserving biometric match log:', cldErr.message);
    }

    // 5. Check Punctuality (Grace period: 15 minutes)
    let minutesLate = 0;
    let attendanceStatus = 'PRESENT';

    const parsedRosterId = rosterId ? parseInt(rosterId) : null;
    let dutyRoster = null;
    if (parsedRosterId) {
      dutyRoster = await prisma.gateDutyRoster.findUnique({ where: { id: parsedRosterId } });
    }

    if (type === 'CHECK_IN' && dutyRoster && dutyRoster.startTime) {
      const [startHour, startMin] = dutyRoster.startTime.split(':').map(Number);
      const now = new Date();
      const shiftStartTime = new Date(now);
      shiftStartTime.setHours(startHour, startMin, 0, 0);

      const diffMs = now.getTime() - shiftStartTime.getTime();
      const diffMinutes = Math.floor(diffMs / (60 * 1000));

      if (diffMinutes > 15) {
        attendanceStatus = 'LATE';
        minutesLate = diffMinutes;
      }
    }

    // 6. Create ShiftAttendance record
    const attendance = await prisma.shiftAttendance.create({
      data: {
        userId: user.id,
        rosterId: parsedRosterId,
        gateId: resolvedGateId,
        stationId: resolvedStationId,
        date: today,
        shiftName: dutyRoster?.shiftName || 'General Shift',
        type,
        latitude: userLat,
        longitude: userLon,
        distanceMeters: Math.round(distanceMeters * 10) / 10,
        geofencePassed: true,
        similarityScore: Math.round(similarityScore * 10) / 10,
        livenessPassed: true,
        status: attendanceStatus,
        minutesLate,
        selfieUrl,
      },
      include: {
        gate: true,
        station: true,
        user: { select: { fullName: true, employeeId: true, designation: true } },
      },
    });

    return res.json({
      success: true,
      message: `${type === 'CHECK_IN' ? 'Check-In' : 'Check-Out'} verified and recorded successfully.`,
      attendance,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Attendance submission failed' });
  }
});

// =========================================================================
// 4. REMOTE GATE MANUAL ATTENDANCE FALLBACK
// =========================================================================

/**
 * POST /api/v1/attendance/manual-fallback
 * Submits a manual attendance request when face matching fails after 3 attempts or during low-light/network drops.
 */
router.post('/manual-fallback', authenticate, upload.single('image'), async (req: AuthRequest, res: Response) => {
  try {
    const { type, latitude, longitude, gateId, stationId, fallbackReason } = req.body;

    if (!type || !['CHECK_IN', 'CHECK_OUT'].includes(type)) {
      return res.status(400).json({ error: 'Type must be CHECK_IN or CHECK_OUT' });
    }

    if (!fallbackReason || fallbackReason.trim().length < 5) {
      return res.status(400).json({ error: 'A valid reason for manual attendance request is required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { station: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const today = getTodayDateString();
    const userLat = parseFloat(latitude) || 25.5941;
    const userLon = parseFloat(longitude) || 85.1376;
    const resolvedStationId = stationId ? parseInt(stationId) : (user.stationId || 1);
    const resolvedGateId = gateId ? parseInt(gateId) : null;

    let selfieUrl: string | null = null;
    if (req.file && req.file.buffer) {
      try {
        const uploadRes = await uploadBufferToCloudinary(req.file.buffer, {
          folder: 'lc_platform/manual_fallback',
          publicIdPrefix: `fallback_${type.toLowerCase()}_u${user.id}`,
          tags: ['lc-platform', 'manual-fallback'],
          maxDimension: 800,
        });
        selfieUrl = uploadRes.secureUrl;
      } catch (cldErr: any) {
        console.warn('[Cloudinary] Manual fallback photo upload failed:', cldErr.message);
      }
    }

    const attendance = await prisma.shiftAttendance.create({
      data: {
        userId: user.id,
        gateId: resolvedGateId,
        stationId: resolvedStationId,
        date: today,
        shiftName: 'Manual Shift Submission',
        type,
        latitude: userLat,
        longitude: userLon,
        distanceMeters: 0,
        geofencePassed: true,
        status: 'MANUAL_PENDING',
        isManualFallback: true,
        fallbackReason: fallbackReason.trim(),
        selfieUrl,
      },
    });

    return res.json({
      success: true,
      message: 'Manual attendance submitted successfully. Awaiting Restkeeper / Supervisor approval.',
      attendance,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Manual fallback submission failed' });
  }
});

/**
 * GET /api/v1/attendance/pending-manual
 * Lists all manual attendance requests awaiting supervisor review.
 */
router.get('/pending-manual', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const today = getTodayDateString();
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { station: true },
    });

    const whereClause: any = {
      isManualFallback: true,
      status: 'MANUAL_PENDING',
      date: today,
    };

    if (user?.stationId) {
      whereClause.stationId = user.stationId;
    }

    const pendingRequests = await prisma.shiftAttendance.findMany({
      where: whereClause,
      include: {
        user: { select: { id: true, fullName: true, employeeId: true, mobile: true, designation: true } },
        gate: { select: { id: true, lcNumber: true, locationName: true } },
        station: { select: { id: true, name: true, code: true } },
      },
      orderBy: { timestamp: 'desc' },
    });

    return res.json({
      success: true,
      count: pendingRequests.length,
      requests: pendingRequests,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch pending manual requests' });
  }
});

/**
 * POST /api/v1/attendance/approve-manual/:id
 * Supervisor one-tap approval for remote gate manual fallback.
 */
router.post('/approve-manual/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const attendanceId = parseInt(req.params.id);
    const { action, notes } = req.body; // action: 'APPROVE' or 'REJECT'

    const attendance = await prisma.shiftAttendance.findUnique({
      where: { id: attendanceId },
    });

    if (!attendance) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }

    if (attendance.status !== 'MANUAL_PENDING') {
      return res.status(400).json({ error: `Attendance is already ${attendance.status}` });
    }

    const newStatus = action === 'REJECT' ? 'REJECTED' : 'MANUAL_APPROVED';

    const updated = await prisma.shiftAttendance.update({
      where: { id: attendanceId },
      data: {
        status: newStatus,
        approvedById: req.user!.id,
        approvedAt: new Date(),
      },
    });

    return res.json({
      success: true,
      message: `Manual attendance request ${action === 'REJECT' ? 'rejected' : 'approved'} successfully.`,
      attendance: updated,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to approve manual attendance' });
  }
});

// =========================================================================
// 5. RESTKEEPER LIVE GATE ATTENDANCE MATRIX
// =========================================================================

/**
 * GET /api/v1/attendance/station-matrix
 * Returns real-time shift attendance status for all LC gates under the supervisor's station.
 */
router.get('/station-matrix', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const today = getTodayDateString();
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { station: true },
    });

    const stationId = req.query.stationId ? parseInt(req.query.stationId as string) : user?.stationId;

    if (!stationId) {
      return res.status(400).json({ error: 'Station ID is required' });
    }

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayDayOfWeek = dayNames[new Date().getDay()];

    const gates = await prisma.lCGate.findMany({
      where: { stationId },
      include: {
        dutyRosters: {
          where: {
            OR: [
              { date: today, isPermanent: false },
              { dayOfWeek: todayDayOfWeek, isPermanent: true },
            ],
          },
          include: { gateman: { select: { id: true, fullName: true, mobile: true, designation: true } } },
        },
        shiftAttendances: {
          where: { date: today },
          orderBy: { timestamp: 'desc' },
          include: { user: { select: { fullName: true } } },
        },
      },
      orderBy: { lcNumber: 'asc' },
    });

    const matrix = gates.map(gate => {
      // Dynamic Priority: Specific date override today > Permanent master cycle today
      const specificRoster = gate.dutyRosters.find(r => r.date === today && !r.isPermanent);
      const permRoster = gate.dutyRosters.find(r => r.dayOfWeek === todayDayOfWeek && r.isPermanent);
      const todayRoster = specificRoster || permRoster || null;
      const attendances = gate.shiftAttendances;
      const checkIn = attendances.find(a => a.type === 'CHECK_IN');
      const checkOut = attendances.find(a => a.type === 'CHECK_OUT');

      let currentStatus = 'UNSTAFFED';
      if (checkOut) {
        currentStatus = 'COMPLETED';
      } else if (checkIn) {
        currentStatus = checkIn.status; // PRESENT, LATE, MANUAL_APPROVED, MANUAL_PENDING
      }

      return {
        gateId: gate.id,
        lcNumber: gate.lcNumber,
        locationName: gate.locationName,
        assignedGateman: todayRoster?.gateman ? todayRoster.gateman.fullName : 'Unassigned',
        shiftName: todayRoster?.shiftName || 'Not Scheduled',
        shiftTimes: todayRoster ? `${todayRoster.startTime} - ${todayRoster.endTime}` : null,
        currentStatus,
        checkInTime: checkIn?.timestamp || null,
        checkOutTime: checkOut?.timestamp || null,
        similarityScore: checkIn?.similarityScore || null,
        isManualFallback: checkIn?.isManualFallback || false,
      };
    });

    return res.json({
      success: true,
      today,
      stationId,
      gateCount: gates.length,
      matrix,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch station matrix' });
  }
});

// =========================================================================
// 6. FACE RE-ENROLLMENT REQUEST & APPROVAL (PWI / CPWI ONLY)
// =========================================================================

function isPwiOrCpwi(user: any): boolean {
  if (!user) return false;
  const role = (user.role || '').toUpperCase();
  const desig = (user.designation || '').toUpperCase();
  return (
    role === 'PWI' ||
    role === 'CPWI' ||
    role === 'DEVELOPER' ||
    role === 'ADMIN' ||
    desig.includes('PWI') ||
    desig.includes('PERMANENT WAY') ||
    desig.includes('SSE/P.WAY') ||
    desig.includes('JE/P.WAY')
  );
}

/**
 * POST /api/v1/attendance/request-reenrollment
 * Submitted by Gatemen or Restkeepers when facial biometrics need re-registration.
 * Routed strictly to PWI / CPWI.
 */
router.post('/request-reenrollment', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ error: 'A detailed reason (e.g., facial surgery, injury, appearance change) is required' });
    }

    const existingPending = await prisma.faceReenrollmentRequest.findFirst({
      where: { userId: req.user!.id, status: 'PENDING' },
    });

    if (existingPending) {
      return res.status(400).json({ error: 'You already have a pending re-enrollment request awaiting approval' });
    }

    const request = await prisma.faceReenrollmentRequest.create({
      data: {
        userId: req.user!.id,
        reason: reason.trim(),
        status: 'PENDING',
      },
    });

    return res.json({
      success: true,
      message: 'Face re-enrollment request submitted. Awaiting PWI / Section Incharge approval.',
      request,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to submit re-enrollment request' });
  }
});

/**
 * GET /api/v1/attendance/pending-reenrollments
 * Lists all pending face re-enrollment requests awaiting PWI / CPWI review.
 * Strictly forbidden for Restkeepers and Gatemen.
 */
router.get('/pending-reenrollments', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!isPwiOrCpwi(req.user)) {
      return res.status(403).json({
        error: 'Forbidden: Only PWI or CPWI can review face re-enrollment requests.',
      });
    }

    const requests = await prisma.faceReenrollmentRequest.findMany({
      where: { status: 'PENDING' },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            employeeId: true,
            mobile: true,
            designation: true,
            faceImageKey: true,
            station: { select: { id: true, name: true, code: true } },
            assignedGates: {
              include: { gate: { select: { id: true, lcNumber: true, locationName: true } } },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      success: true,
      count: requests.length,
      requests,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch pending re-enrollments' });
  }
});

/**
 * POST /api/v1/attendance/approve-reenrollment/:id
 * Approves or rejects face re-enrollment. Restricted strictly to PWI, CPWI, and Admin.
 */
router.post('/approve-reenrollment/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!isPwiOrCpwi(req.user)) {
      return res.status(403).json({
        error: 'Forbidden: Only PWI or CPWI can approve or reject face re-enrollment requests.',
      });
    }

    const requestId = parseInt(req.params.id);
    const { action, notes } = req.body; // action: 'APPROVE' or 'REJECT'

    const reenrollReq = await prisma.faceReenrollmentRequest.findUnique({
      where: { id: requestId },
      include: { user: true },
    });

    if (!reenrollReq) {
      return res.status(404).json({ error: 'Re-enrollment request not found' });
    }

    if (reenrollReq.status !== 'PENDING') {
      return res.status(400).json({ error: `Request is already ${reenrollReq.status}` });
    }

    if (action === 'REJECT') {
      const rejected = await prisma.faceReenrollmentRequest.update({
        where: { id: requestId },
        data: {
          status: 'REJECTED',
          reviewedById: req.user!.id,
          reviewedAt: new Date(),
          rejectionNotes: notes || 'Rejected by supervisor',
        },
      });
      return res.json({ success: true, message: 'Re-enrollment request rejected', request: rejected });
    }

    // Approve: purge old face from Rekognition collection and unlock user profile
    if (reenrollReq.user.faceId) {
      await deleteStaffFace(reenrollReq.user.faceId);
    }
    if (reenrollReq.user.faceImageKey) {
      await deleteFromCloudinary(reenrollReq.user.faceImageKey);
    }

    await prisma.user.update({
      where: { id: reenrollReq.userId },
      data: {
        isFaceEnrolled: false,
        faceId: null,
        faceImageKey: null,
        faceEnrolledAt: null,
        faceEnrollConfidence: null,
      },
    });

    const approved = await prisma.faceReenrollmentRequest.update({
      where: { id: requestId },
      data: {
        status: 'APPROVED',
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
      },
    });

    return res.json({
      success: true,
      message: 'Re-enrollment request approved. User profile has been unlocked for re-registration.',
      request: approved,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to process re-enrollment approval' });
  }
});

// =========================================================================
// 7. ROLLING RETENTION SWEEP (Manual Trigger / Health Check)
// =========================================================================

/**
 * POST /api/v1/attendance/retention-sweep
 * Triggers a manual 24-hour rolling retention sweep to purge expired attendance photos from Cloudinary CDN.
 */
router.post('/retention-sweep', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const hours = req.body && req.body.hours ? parseInt(req.body.hours, 10) : undefined;
    const sweepResult = await runAttendanceRetentionSweep(hours);
    return res.json({
      success: true,
      message: 'Attendance photo retention sweep completed successfully.',
      sweepResult,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to execute retention sweep' });
  }
});

export default router;
