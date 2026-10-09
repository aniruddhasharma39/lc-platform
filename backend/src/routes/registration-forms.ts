import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireModule } from '../middleware/auth';

const router = Router();

// Public route to get the live form for registration page
router.get('/live', async (req, res, next) => {
  try {
    const form = await prisma.registrationForm.findFirst({
      where: { status: 'LIVE' }
    });
    
    if (!form) {
      return res.status(404).json({ error: 'No live registration form found' });
    }
    
    res.json(form);
  } catch (error) {
    next(error);
  }
});

// Admin routes
router.use(authenticate);
router.use(requireModule('registration'));

router.get('/', async (req, res, next) => {
  try {
    const forms = await prisma.registrationForm.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json(forms);
  } catch (error) {
    next(error);
  }
});

const formSchema = z.object({
  name: z.string().min(1),
  schema: z.string(), // JSON string representing fields
});

router.post('/', async (req, res, next) => {
  try {
    const data = formSchema.parse(req.body);
    const form = await prisma.registrationForm.create({
      data: {
        name: data.name,
        schema: data.schema,
        status: 'DRAFT',
        version: 1
      }
    });
    res.status(201).json(form);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = formSchema.parse(req.body);

    const existing = await prisma.registrationForm.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Form not found' });
    }
    
    const form = await prisma.registrationForm.update({
      where: { id },
      data: {
        name: data.name,
        schema: data.schema,
      }
    });
    res.json(form);
  } catch (error) {
    next(error);
  }
});

// Publish a form (makes it LIVE, archives the previous LIVE one)
router.put('/:id/publish', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    
    const formToPublish = await prisma.registrationForm.findUnique({ where: { id } });
    if (!formToPublish) {
      return res.status(404).json({ error: 'Form not found' });
    }

    if (formToPublish.status === 'LIVE') {
      return res.json(formToPublish);
    }

    await prisma.$transaction(async (tx) => {
      // Archive current LIVE form
      await tx.registrationForm.updateMany({
        where: { status: 'LIVE' },
        data: { status: 'ARCHIVED' }
      });

      // Set new form to LIVE
      await tx.registrationForm.update({
        where: { id },
        data: { status: 'LIVE' }
      });
    });

    const publishedForm = await prisma.registrationForm.findUnique({ where: { id } });
    res.json(publishedForm);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const form = await prisma.registrationForm.findUnique({ where: { id } });
    if (!form) return res.status(404).json({ error: 'Form not found' });
    if (form.status === 'LIVE') return res.status(400).json({ error: 'Cannot delete a LIVE form. Publish another form first.' });

    await prisma.registrationForm.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
