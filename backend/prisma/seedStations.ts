import { PrismaClient } from '@prisma/client';
import { RAILWAY_STATIONS, findZoneForDivision } from '../src/lib/railwayData';

const prisma = new PrismaClient();

export async function ensureStationsPopulated() {
  const count = await prisma.station.count();
  console.log(`Current station count in database: ${count}`);
  if (count < 500) {
    let inserted = 0;
    for (const [division, stations] of Object.entries(RAILWAY_STATIONS)) {
      const zone = findZoneForDivision(division) || 'Central Railway';
      for (const st of stations) {
        await prisma.station.upsert({
          where: { code: st.code },
          update: { name: st.name, division, zone },
          create: { code: st.code, name: st.name, division, zone },
        });
        inserted++;
      }
    }
    console.log(`Successfully populated/updated ${inserted} railway stations in database.`);
  }
}

if (require.main === module) {
  ensureStationsPopulated()
    .catch((err) => {
      console.error('Error seeding stations:', err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}

