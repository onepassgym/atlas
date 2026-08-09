'use strict';
const { connectDB, disconnectDB } = require('../src/db/connection');
const mongoose = require('mongoose');

// v5 collection names: space_categories, space_amenities
// Expanded to cover all fitness/wellness categories ATLAS will scrape

const CATEGORIES = [
  // ── Primary fitness ───────────────────────────────────────────────────────
  { slug: 'gym',                  key: 'gym',                  name: 'Gym',                     category: 'fitness',  order: 1 },
  { slug: 'fitness-center',       key: 'fitness_center',       name: 'Fitness Center',           category: 'fitness',  order: 2 },
  { slug: 'yoga-studio',          key: 'yoga_studio',          name: 'Yoga Studio',              category: 'wellness', order: 3 },
  { slug: 'crossfit-box',         key: 'crossfit_box',         name: 'CrossFit Box',             category: 'fitness',  order: 4 },
  { slug: 'pilates-studio',       key: 'pilates_studio',       name: 'Pilates Studio',           category: 'wellness', order: 5 },
  { slug: 'martial-arts',         key: 'martial_arts',         name: 'Martial Arts',             category: 'combat',   order: 6 },
  { slug: 'boxing-gym',           key: 'boxing_gym',           name: 'Boxing Gym',               category: 'combat',   order: 7 },
  { slug: 'dance-studio',         key: 'dance_studio',         name: 'Dance Studio',             category: 'dance',    order: 8 },
  { slug: 'swimming-pool',        key: 'swimming_pool',        name: 'Swimming Pool',            category: 'aquatics', order: 9 },
  { slug: 'personal-training',    key: 'personal_training',    name: 'Personal Training Studio', category: 'fitness',  order: 10 },
  // ── Strength & conditioning ───────────────────────────────────────────────
  { slug: 'functional-training',  key: 'functional_training',  name: 'Functional Training',      category: 'fitness',  order: 11 },
  { slug: 'hiit-studio',          key: 'hiit_studio',          name: 'HIIT Studio',              category: 'fitness',  order: 12 },
  { slug: 'ems-studio',           key: 'ems_studio',           name: 'EMS Studio',               category: 'fitness',  order: 13 },
  { slug: 'calisthenics',         key: 'calisthenics',         name: 'Calisthenics',             category: 'fitness',  order: 14 },
  { slug: 'powerlifting',         key: 'powerlifting',         name: 'Powerlifting',             category: 'fitness',  order: 15 },
  // ── Wellness ─────────────────────────────────────────────────────────────
  { slug: 'aerial-yoga',          key: 'aerial_yoga',          name: 'Aerial Yoga',              category: 'wellness', order: 16 },
  { slug: 'meditation-center',    key: 'meditation_center',    name: 'Meditation Center',        category: 'wellness', order: 17 },
  { slug: 'spa-wellness',         key: 'spa_wellness',         name: 'Spa & Wellness',           category: 'wellness', order: 18 },
  { slug: 'physiotherapy',        key: 'physiotherapy',        name: 'Physiotherapy',            category: 'wellness', order: 19 },
  { slug: 'sports-rehab',         key: 'sports_rehab',         name: 'Sports Rehabilitation',    category: 'wellness', order: 20 },
  // ── Combat sports ─────────────────────────────────────────────────────────
  { slug: 'mma-gym',              key: 'mma_gym',              name: 'MMA Gym',                  category: 'combat',   order: 21 },
  { slug: 'wrestling',            key: 'wrestling',            name: 'Wrestling Academy',        category: 'combat',   order: 22 },
  { slug: 'judo',                 key: 'judo',                 name: 'Judo Academy',             category: 'combat',   order: 23 },
  { slug: 'karate',               key: 'karate',               name: 'Karate Academy',           category: 'combat',   order: 24 },
  // ── Cycling & Endurance ───────────────────────────────────────────────────
  { slug: 'cycling-studio',       key: 'cycling_studio',       name: 'Cycling Studio',           category: 'cardio',   order: 25 },
  { slug: 'running-club',         key: 'running_club',         name: 'Running Club',             category: 'cardio',   order: 26 },
  // ── Dance ─────────────────────────────────────────────────────────────────
  { slug: 'zumba',                key: 'zumba',                name: 'Zumba',                    category: 'dance',    order: 27 },
  { slug: 'barre',                key: 'barre',                name: 'Barre',                    category: 'dance',    order: 28 },
  { slug: 'bollywood-dance',      key: 'bollywood_dance',      name: 'Bollywood Dance',          category: 'dance',    order: 29 },
  // ── Court & Field sports ──────────────────────────────────────────────────
  { slug: 'badminton-court',      key: 'badminton_court',      name: 'Badminton Court',          category: 'sports',   order: 30 },
  { slug: 'tennis-academy',       key: 'tennis_academy',       name: 'Tennis Academy',           category: 'sports',   order: 31 },
  { slug: 'basketball-court',     key: 'basketball_court',     name: 'Basketball Court',         category: 'sports',   order: 32 },
  { slug: 'football-turf',        key: 'football_turf',        name: 'Football Turf',            category: 'sports',   order: 33 },
  { slug: 'cricket-academy',      key: 'cricket_academy',      name: 'Cricket Academy',          category: 'sports',   order: 34 },
  { slug: 'squash-court',         key: 'squash_court',         name: 'Squash Court',             category: 'sports',   order: 35 },
  // ── Climbing & Adventure ──────────────────────────────────────────────────
  { slug: 'climbing-wall',        key: 'climbing_wall',        name: 'Climbing Wall',            category: 'adventure',order: 36 },
  { slug: 'parkour',              key: 'parkour',              name: 'Parkour',                  category: 'adventure',order: 37 },
  // ── Multi-sport ───────────────────────────────────────────────────────────
  { slug: 'sports-complex',       key: 'sports_complex',       name: 'Sports Complex',           category: 'multi',    order: 38 },
  { slug: 'health-club',          key: 'health_club',          name: 'Health Club',              category: 'fitness',  order: 39 },
  { slug: 'community-center',     key: 'community_center',     name: 'Community Fitness Center', category: 'multi',    order: 40 },
];

const AMENITIES = [
  // ── Facilities ────────────────────────────────────────────────────────────
  { slug: 'parking',               key: 'parking',               name: 'Parking',               category: 'facility'  },
  { slug: 'locker-rooms',          key: 'locker_rooms',          name: 'Locker Rooms',          category: 'facility'  },
  { slug: 'showers',               key: 'showers',               name: 'Showers',               category: 'facility'  },
  { slug: 'changing-rooms',        key: 'changing_rooms',        name: 'Changing Rooms',        category: 'facility'  },
  { slug: 'air-conditioning',      key: 'air_conditioning',      name: 'Air Conditioning',      category: 'facility'  },
  { slug: 'wifi',                  key: 'wifi',                  name: 'Wi-Fi',                 category: 'facility'  },
  { slug: 'wheelchair-accessible', key: 'wheelchair_accessible', name: 'Wheelchair Accessible', category: 'facility'  },
  { slug: 'restrooms',             key: 'restrooms',             name: 'Restrooms',             category: 'facility'  },
  { slug: 'waiting-area',          key: 'waiting_area',          name: 'Waiting Area',          category: 'facility'  },
  { slug: 'reception',             key: 'reception',             name: 'Reception',             category: 'facility'  },
  // ── Equipment ─────────────────────────────────────────────────────────────
  { slug: 'free-weights',          key: 'free_weights',          name: 'Free Weights',          category: 'equipment' },
  { slug: 'cardio-machines',       key: 'cardio_machines',       name: 'Cardio Machines',       category: 'equipment' },
  { slug: 'strength-machines',     key: 'strength_machines',     name: 'Strength Machines',     category: 'equipment' },
  { slug: 'functional-equipment',  key: 'functional_equipment',  name: 'Functional Equipment',  category: 'equipment' },
  { slug: 'boxing-equipment',      key: 'boxing_equipment',      name: 'Boxing Equipment',      category: 'equipment' },
  { slug: 'yoga-mats',             key: 'yoga_mats',             name: 'Yoga Mats',             category: 'equipment' },
  { slug: 'resistance-bands',      key: 'resistance_bands',      name: 'Resistance Bands',      category: 'equipment' },
  { slug: 'battle-ropes',          key: 'battle_ropes',          name: 'Battle Ropes',          category: 'equipment' },
  // ── Services ──────────────────────────────────────────────────────────────
  { slug: 'personal-trainer',      key: 'personal_trainer',      name: 'Personal Trainer',      category: 'service'   },
  { slug: 'group-classes',         key: 'group_classes',         name: 'Group Classes',         category: 'service'   },
  { slug: 'nutrition-counseling',  key: 'nutrition_counseling',  name: 'Nutrition Counseling',  category: 'service'   },
  { slug: 'diet-plan',             key: 'diet_plan',             name: 'Diet Plan',             category: 'service'   },
  { slug: 'body-composition',      key: 'body_composition',      name: 'Body Composition Analysis', category: 'service' },
  { slug: 'online-classes',        key: 'online_classes',        name: 'Online Classes',        category: 'service'   },
  { slug: 'trial-class',           key: 'trial_class',           name: 'Free Trial Class',      category: 'service'   },
  // ── Wellness ──────────────────────────────────────────────────────────────
  { slug: 'sauna',                 key: 'sauna',                 name: 'Sauna',                 category: 'wellness'  },
  { slug: 'steam-room',            key: 'steam_room',            name: 'Steam Room',            category: 'wellness'  },
  { slug: 'jacuzzi',               key: 'jacuzzi',               name: 'Jacuzzi',               category: 'wellness'  },
  { slug: 'massage',               key: 'massage',               name: 'Massage',               category: 'wellness'  },
  { slug: 'ice-bath',              key: 'ice_bath',              name: 'Ice Bath / Cold Plunge', category: 'wellness' },
  // ── Access ────────────────────────────────────────────────────────────────
  { slug: '24-7-access',           key: 'h24_access',            name: '24/7 Access',           category: 'access'    },
  { slug: 'women-only',            key: 'women_only',            name: "Women-Only Section",    category: 'access'    },
  { slug: 'couples-allowed',       key: 'couples_allowed',       name: 'Couples Allowed',       category: 'access'    },
  { slug: 'no-membership',         key: 'no_membership',         name: 'Drop-In / No Membership', category: 'access'  },
  // ── Food & Beverage ───────────────────────────────────────────────────────
  { slug: 'juice-bar',             key: 'juice_bar',             name: 'Juice Bar',             category: 'food'      },
  { slug: 'cafeteria',             key: 'cafeteria',             name: 'Cafeteria',             category: 'food'      },
  { slug: 'protein-shakes',        key: 'protein_shakes',        name: 'Protein Shakes',        category: 'food'      },
  { slug: 'supplements-shop',      key: 'supplements_shop',      name: 'Supplements Shop',      category: 'food'      },
  // ── Pool ──────────────────────────────────────────────────────────────────
  { slug: 'swimming-pool-amenity', key: 'swimming_pool',         name: 'Swimming Pool',         category: 'facility'  },
  { slug: 'indoor-pool',           key: 'indoor_pool',           name: 'Indoor Pool',           category: 'facility'  },
  { slug: 'outdoor-pool',          key: 'outdoor_pool',          name: 'Outdoor Pool',          category: 'facility'  },
];

async function seedStaticData() {
  await connectDB();
  const db = mongoose.connection.db;
  console.log('Seeding v5 static reference collections (space_categories, space_amenities)...');

  const now = new Date();
  let catCount = 0;
  let amenCount = 0;

  for (const cat of CATEGORIES) {
    const res = await db.collection('space_categories').updateOne(
      { slug: cat.slug },
      {
        $setOnInsert: {
          slug: cat.slug,
          key: cat.key,
          name: cat.name,
          description: cat.description || '',
          color: cat.color || '#6B7280',
          accent: cat.accent || '#111827',
          imageUrl: null,
          parentSlug: null,
          category: cat.category,
          order: cat.order,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        }
      },
      { upsert: true }
    );
    if (res.upsertedCount) catCount++;
  }

  for (const am of AMENITIES) {
    const res = await db.collection('space_amenities').updateOne(
      { slug: am.slug },
      {
        $setOnInsert: {
          slug: am.slug,
          key: am.key,
          name: am.name,
          category: am.category,
          icon: am.icon || null,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        }
      },
      { upsert: true }
    );
    if (res.upsertedCount) amenCount++;
  }

  console.log(`Seeded: ${catCount} new categories, ${amenCount} new amenities.`);
  await disconnectDB();
}

if (require.main === module) {
  seedStaticData().catch(console.error).finally(() => process.exit(0));
}

module.exports = { seedStaticData, CATEGORIES, AMENITIES };
