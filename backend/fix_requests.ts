import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const requests = await prisma.registrationRequest.findMany({
    include: { form: true }
  });

  for (const req of requests) {
    if (!req.data) continue;

    try {
      const schema = JSON.parse(req.form.schema);
      const allFields: any[] = [];
      const walk = (fields: any[]) => {
        for (const f of fields) {
          if (f.type === 'section' && f.children) walk(f.children);
          else allFields.push(f);
        }
      };
      if (schema.fields) walk(schema.fields);

      const meta = JSON.parse(req.data);
      let changed = false;
      const newMeta: any = {};

      for (const [k, v] of Object.entries(meta)) {
        if (k.toLowerCase() === 'password') {
            newMeta[k] = v; // Keep password in pending request as it needs to be approved and saved
            continue;
        }
        
        const field = allFields.find(f => f.name === k);
        if (field) {
          newMeta[field.label] = v;
          changed = true;
        } else {
          newMeta[k] = v;
        }
      }

      if (changed) {
        const finalMeta: any = {};
        for (const [k, v] of Object.entries(newMeta)) {
            if (!k.startsWith('field_')) finalMeta[k] = v;
            else finalMeta[k] = v; // Can't map it, keep it
        }
        
        await prisma.registrationRequest.update({
          where: { id: req.id },
          data: { data: JSON.stringify(finalMeta) }
        });
        console.log(`Updated request ${req.id}`);
      }
    } catch (e) {
      console.log(`Failed to parse for request ${req.id}:`, e);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
