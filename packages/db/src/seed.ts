// Loads the league (teams and players for the current ENGINE_VERSION) into the database. Idempotent.
import { ENGINE_VERSION, TEAMS } from "@oddra/engine";
import { db } from "./index";

async function main() {
  const prisma = db();
  for (const t of TEAMS) {
    await prisma.team.upsert({
      where: { id: t.id },
      create: {
        id: t.id,
        name: t.name,
        short: t.short,
        kitHome: t.kit[0],
        kitAway: t.kit[1],
        formation: t.formation,
        rating: t.rating,
      },
      update: {
        name: t.name,
        short: t.short,
        kitHome: t.kit[0],
        kitAway: t.kit[1],
        formation: t.formation,
        rating: t.rating,
      },
    });
    for (let slot = 0; slot < t.players.length; slot++) {
      const p = t.players[slot];
      await prisma.player.upsert({
        where: { teamId_slot_version: { teamId: t.id, slot, version: ENGINE_VERSION } },
        create: {
          teamId: t.id,
          slot,
          number: p.number,
          name: p.name,
          role: p.role,
          attrs: { ...p.attrs },
          version: ENGINE_VERSION,
        },
        update: { number: p.number, name: p.name, role: p.role, attrs: { ...p.attrs } },
      });
    }
  }
  console.log(`seeded ${TEAMS.length} teams for ${ENGINE_VERSION}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
