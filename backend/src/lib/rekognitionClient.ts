import {
  RekognitionClient,
  CreateCollectionCommand,
  DescribeCollectionCommand,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  CompareFacesCommand,
  DeleteFacesCommand,
  ResourceNotFoundException,
  ResourceAlreadyExistsException,
} from '@aws-sdk/client-rekognition';
import dotenv from 'dotenv';

dotenv.config();

export const DEFAULT_COLLECTION_ID = process.env.REKOGNITION_COLLECTION_ID || 'lc-gate-staff-collection';
export const DEFAULT_SIMILARITY_THRESHOLD = parseFloat(process.env.REKOGNITION_SIMILARITY_THRESHOLD || '95.0');

let rekognitionClient: RekognitionClient | null = null;

/**
 * Returns a singleton instance of the AWS Rekognition client.
 */
export function getRekognitionClient(): RekognitionClient {
  dotenv.config();

  const region = process.env.AWS_REGION || 'ap-south-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!rekognitionClient) {
    rekognitionClient = new RekognitionClient({
      region,
      credentials: accessKeyId && secretAccessKey ? {
        accessKeyId,
        secretAccessKey,
      } : undefined, // Will fall back to EC2 IAM Role or ~/.aws/credentials
    });
  }

  return rekognitionClient;
}

/**
 * Ensures the target Rekognition Collection exists, creating it if necessary.
 */
export async function ensureCollectionExists(collectionId: string = DEFAULT_COLLECTION_ID): Promise<{
  success: boolean;
  collectionArn?: string;
  created?: boolean;
  error?: string;
}> {
  const client = getRekognitionClient();
  try {
    // Check if collection already exists
    const describeCmd = new DescribeCollectionCommand({ CollectionId: collectionId });
    const describeRes = await client.send(describeCmd);
    return {
      success: true,
      collectionArn: describeRes.CollectionARN,
      created: false,
    };
  } catch (err: any) {
    if (err.name === 'ResourceNotFoundException' || err instanceof ResourceNotFoundException) {
      try {
        const createCmd = new CreateCollectionCommand({ CollectionId: collectionId });
        const createRes = await client.send(createCmd);
        return {
          success: true,
          collectionArn: createRes.CollectionArn,
          created: true,
        };
      } catch (createErr: any) {
        if (createErr.name === 'ResourceAlreadyExistsException' || createErr instanceof ResourceAlreadyExistsException) {
          return { success: true, created: false };
        }
        return { success: false, error: createErr.message || String(createErr) };
      }
    }
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Sanitizes employee ID for AWS Rekognition ExternalImageId
 * Rekognition allows: [a-zA-Z0-9_.\-:]+
 */
function sanitizeExternalImageId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.\-:]/g, '_').substring(0, 255);
}

/**
 * Indexes a single staff member's face into the collection.
 * Enforces single face detection with high quality filter.
 */
export async function indexStaffFace(params: {
  imageBytes: Buffer;
  employeeId: string;
  collectionId?: string;
}): Promise<{
  success: boolean;
  faceId?: string;
  confidence?: number;
  boundingBox?: any;
  error?: string;
}> {
  const client = getRekognitionClient();
  const collectionId = params.collectionId || DEFAULT_COLLECTION_ID;

  try {
    const cmd = new IndexFacesCommand({
      CollectionId: collectionId,
      Image: { Bytes: params.imageBytes },
      ExternalImageId: sanitizeExternalImageId(`emp_${params.employeeId}`),
      DetectionAttributes: ['ALL'],
      MaxFaces: 1,
      QualityFilter: 'AUTO',
    });

    const res = await client.send(cmd);

    if (!res.FaceRecords || res.FaceRecords.length === 0) {
      const unindexedReason = res.UnindexedFaces?.[0]?.Reasons?.join(', ') || 'No clear single face detected';
      return {
        success: false,
        error: `Face enrollment failed: ${unindexedReason}. Please ensure a front-facing, well-lit photo with no sunglasses or masks.`,
      };
    }

    const faceRecord = res.FaceRecords[0];
    const faceId = faceRecord.Face?.FaceId;
    const confidence = faceRecord.Face?.Confidence || 0;

    return {
      success: true,
      faceId,
      confidence,
      boundingBox: faceRecord.Face?.BoundingBox,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || String(err),
    };
  }
}

/**
 * Searches the collection for a match with the live captured selfie.
 */
export async function searchFaceInCollection(params: {
  imageBytes: Buffer;
  collectionId?: string;
  faceMatchThreshold?: number;
}): Promise<{
  success: boolean;
  matchedFaceId?: string;
  similarity?: number;
  externalImageId?: string;
  error?: string;
}> {
  const client = getRekognitionClient();
  const collectionId = params.collectionId || DEFAULT_COLLECTION_ID;
  const threshold = params.faceMatchThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  try {
    const cmd = new SearchFacesByImageCommand({
      CollectionId: collectionId,
      Image: { Bytes: params.imageBytes },
      FaceMatchThreshold: threshold,
      MaxFaces: 1,
    });

    const res = await client.send(cmd);

    if (!res.FaceMatches || res.FaceMatches.length === 0) {
      return {
        success: false,
        similarity: 0,
        error: `Face does not match registered profile (below ${threshold}% threshold).`,
      };
    }

    const bestMatch = res.FaceMatches[0];
    return {
      success: true,
      matchedFaceId: bestMatch.Face?.FaceId,
      similarity: bestMatch.Similarity,
      externalImageId: bestMatch.Face?.ExternalImageId,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || String(err),
    };
  }
}

/**
 * Directly compares two face images (source reference image vs target live selfie).
 */
export async function compareFaceImages(params: {
  sourceBytes: Buffer;
  targetBytes: Buffer;
  similarityThreshold?: number;
}): Promise<{
  success: boolean;
  isMatch: boolean;
  similarity?: number;
  error?: string;
}> {
  const client = getRekognitionClient();
  const threshold = params.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  try {
    const cmd = new CompareFacesCommand({
      SourceImage: { Bytes: params.sourceBytes },
      TargetImage: { Bytes: params.targetBytes },
      SimilarityThreshold: threshold,
    });

    const res = await client.send(cmd);

    if (!res.FaceMatches || res.FaceMatches.length === 0) {
      return {
        success: true,
        isMatch: false,
        similarity: 0,
      };
    }

    const match = res.FaceMatches[0];
    const similarity = match.Similarity || 0;

    return {
      success: true,
      isMatch: similarity >= threshold,
      similarity,
    };
  } catch (err: any) {
    return {
      success: false,
      isMatch: false,
      error: err.message || String(err),
    };
  }
}

/**
 * Deletes an indexed face from the Rekognition collection.
 * Used during authorized re-enrollment.
 */
export async function deleteStaffFace(
  faceId: string,
  collectionId: string = DEFAULT_COLLECTION_ID
): Promise<{ success: boolean; error?: string }> {
  const client = getRekognitionClient();

  try {
    const cmd = new DeleteFacesCommand({
      CollectionId: collectionId,
      FaceIds: [faceId],
    });

    await client.send(cmd);
    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || String(err),
    };
  }
}
