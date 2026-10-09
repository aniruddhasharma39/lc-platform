import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany();
  const form = await prisma.registrationForm.findFirst({
    where: { status: 'LIVE' },
    orderBy: { createdAt: 'desc' }
  });

  if (!form) {
    console.log('No LIVE form found to map fields.');
    return;
  }

  const schema = JSON.parse(form.schema);
  const allFields: any[] = [];
  
  const walk = (fields: any[]) => {
    for (const f of fields) {
      if (f.type === 'section' && f.children) walk(f.children);
      else allFields.push(f);
    }
  };
  
  if (schema.fields) walk(schema.fields);

  for (const user of users) {
    if (!user.metadata) continue;

    try {
      const meta = JSON.parse(user.metadata);
      let changed = false;
      const newMeta: any = {};

      for (const [k, v] of Object.entries(meta)) {
        if (k.toLowerCase() === 'password') continue;
        
        const field = allFields.find(f => f.name === k);
        if (field) {
          newMeta[field.label] = v;
          changed = true;
        } else {
          // Keep existing keys if they are already mapped or not found
          newMeta[k] = v;
        }
      }

      if (changed) {
        // Also remove any residual field_ keys if they were mapped
        const finalMeta: any = {};
        for (const [k, v] of Object.entries(newMeta)) {
            if (!k.startsWith('field_')) {
                finalMeta[k] = v;
            } else {
                // If it couldn't be mapped, keep it, but maybe just call it "Data Field"
                finalMeta[k] = v;
            }
        }
        await prisma.user.update({
          where: { id: user.id },
          data: { metadata: JSON.stringify(finalMeta) }
        });
        console.log(`Updated user ${user.fullName} (${user.id})`);
      }
    } catch (e) {
      console.log(`Failed to parse metadata for ${user.fullName}:`, e);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
