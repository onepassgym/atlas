// ══════════════════════════════════════════════════════════════════
// OnePassGym — OPG DB Architecture
// Paste into https://dbdiagram.io/d
// Umbrella: opg-*   |   ID key: opgId (human-readable)   |   _id: Mongo internal
// ══════════════════════════════════════════════════════════════════
//
//  WHAT CHANGED FROM v4
//  ────────────────────────────────────────────────────────────────
//  • 5 DBs → 4 clusters. CMS + blog merged into opg-content so
//    posts can $lookup authors/categories instead of duplicating them.
//  • Cross-cluster duplication minimized: only the rendered URL is
//    denormalized from opg-media; full asset metadata lives once.
//  • Partners normalized: partners (business) ↔ partner_spaces (link).
//    A chain stores its business/GST data ONCE.
//  • users.savedSpaces[] (unbounded array) → saves collection.
//  • space_reviews now links userOpgId + checkinOpgId for native reviews.
//  • Added: locations, devices, bookings, classes, schedules,
//    pass_ledger, offers, coupons, coupon_redemptions, referrals,
//    rewards, reward_items, leads, profiler_results, invoices,
//    payment_events, app_config.
//  • Mobile: devices (push), app_config (force-update/flags),
//    deletedAt soft-delete + updatedAt everywhere → delta sync.
//  • Archival layer specced separately (cold path, not wired hot).
//
//  ════════════════════════════════════════════════════════════════
//  ID GENERATION CONTRACT  —  makeOpgId(entity, { highVolume })
//  ════════════════════════════════════════════════════════════════
//  Format:  {ENTITY}-{WORD}-{base32tail}
//    ENTITY    load-bearing 3-letter prefix → tells polymorphic refs
//              what a record IS (USR / PAY / SPC ...). NEVER the app name.
//    WORD      cosmetic 4-7 letter animal/bird. IGNORED for uniqueness.
//    base32    the only entropy. 11 chars (~55 bits) normal tables;
//              13-14 chars (~70 bits) for high-volume atlas tables.
//  Examples:   USR-FALCON-7K2F9QX4M3P
//              SPC-TIGER-9QX4M3PA7KF2QH
//  Both IDs generated in app code → ZERO db round-trip → no insert
//  slowdown. _id stays ObjectId (driver-side). opgId is unique-indexed.
//  Counter/sequence is used in exactly ONE place: invoices (GST law
//  requires sequential numbers). Nowhere else.
//
//  createdVia on every record:  web | mobile | cms | agent | api | crawler | system
//
//  PREFIX REGISTRY
//  ── atlas:    SPC space · RVW review · PHT photo · CHN chain · LOC location
//               (space_categories / space_amenities use natural slug PK)
//  ── core:     USR user · DEV device · MBR membership · PAY payment ·
//               PEV payment_event · INV invoice · CHK checkin · BKG booking ·
//               CLS class · SCH schedule · LDG pass_ledger · PTR partner ·
//               PSP partner_space · OFR offer · CPN coupon · CRD redemption ·
//               REF referral · RWD reward · LED lead · PRF profiler · SAV save ·
//               AUD audit · NTF notification
//  ── content:  PGE page · WGT widget · FAQ faq · PLN plan · TST testimonial ·
//               CTY city_guide · BNR banner · RDR redirect · NAV nav · CFG config ·
//               PST post · BCA blog_category · ATH author · TAG tag · RWI reward_item
//  ── media:    AST asset · VAR variant
//
//  CROSS-DB REF POLICY
//  • Same cluster  → real ref + $lookup. Store the fact ONCE.
//  • Cross cluster → store {opgId} + the single rendered string (url/slug).
//                    Resolve full record from owner DB when needed.
//  • Polymorphic targets (audit.entityOpgId, media.ownerOpgId) → note only,
//    not a hard ref (DBML can't ref multiple tables).
//
//  SYNC STRATEGY
//  • Inside a cluster: none — $lookup live.
//  • Cross-cluster low-churn (media url swap, space rename → testimonial
//    snapshot): MongoDB change-streams (Atlas replica set = free).
//  • Aggregate counts (spaceCount, views, helpful, bookedCount):
//    nightly cron reconcile. Never hot-path.
// ══════════════════════════════════════════════════════════════════


Project opg_db {
  database_type: 'MongoDB'
  Note: 'OnePassGym — 4 clusters: opg-atlas, opg-core, opg-content, opg-media. Plus cold archival layer.'
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  CLUSTER: opg-atlas                                           ║
// ║  Crawler-owned discoverable catalog. Read-mostly from app.    ║
// ╚══════════════════════════════════════════════════════════════╝

Table locations {
  opgId           string   [pk, note: 'LOC-XXXX · canonical geo node']
  _id             ObjectId [unique]
  type            string   [note: 'country|state|city|area · indexed']
  parentOpgId     string   [ref: > locations.opgId, note: 'self hierarchy · nullable']
  slug            string   [unique, note: 'e.g. delhi · gurgaon-sector-29 · indexed']
  name            string
  displayName     string   [note: 'e.g. Sector 29, Gurgaon']
  state           string   [note: 'indexed']
  country         string   [note: 'default IN']
  center          object   [note: '{type:Point,coordinates:[lng,lat]} · 2dsphere']
  bounds          object   [note: 'optional bbox for map']
  aliases         string[] [note: 'replaces hardcoded geoResolver lookup']
  pincodes        string[]
  spaceCount      int      [note: 'cached · cron · powers city×category SEO']
  isServiceable   boolean  [note: 'OPG live here · gates expansion']
  seo             object   [note: '{metaTitle,metaDesc,keywords,ogImage,canonical}']
  createdVia      string
  isActive        boolean
  deletedAt       datetime [note: 'soft-delete · nullable']
  createdAt       datetime
  updatedAt       datetime
  indexes {
    (type, isServiceable) [name: 'idx_loc_type_serviceable']
    (parentOpgId, type)   [name: 'idx_loc_parent']
  }
}

Table spaces {
  opgId               string     [pk, note: 'SPC-XXXX · indexed']
  _id                 ObjectId   [unique]

  // Identity
  placeId             string     [unique, note: 'Google Place ID · nullable · indexed']
  googleMapsUrl       string
  name                string     [note: 'indexed']
  slug                string     [unique, note: 'URL routing · indexed']
  aliases             string[]

  // Classification
  primaryCategorySlug string     [ref: > space_categories.slug, note: 'indexed']
  categorySlugs       string[]   [note: 'ref space_categories.slug[]']
  amenitySlugs        string[]   [note: 'ref space_amenities.slug[]']
  tags                string[]   [note: 'freeform · Typesense embed']
  chainOpgId          string     [ref: > space_chains.opgId, note: 'nullable']

  // Location (normalized + denorm display)
  cityOpgId           string     [ref: > locations.opgId, note: 'canonical · indexed']
  areaOpgId           string     [ref: > locations.opgId, note: 'canonical · nullable · indexed']
  location            object     [note: '{type:Point,coordinates:[lng,lat]} · 2dsphere']
  address             string
  areaName            string     [note: 'denorm display']
  city                string     [note: 'denorm display']
  state               string
  pincode             string
  plusCode            string
  country             string     [note: 'default IN']

  // Contact / Ratings / Media / Details (as v4)
  contact             object     [note: '{phone,website,email}']
  rating              float      [note: 'indexed']
  totalReviews        int
  reviewsScraped      int
  ratingBreakdown     object
  sentimentScore      float
  sentimentTags       object     [note: '{positive:[],negative:[]}']
  coverAssetOpgId     string     [ref: > media_assets.opgId, note: 'cross-DB']
  coverUrl            string     [note: 'denorm rendered url only']
  totalPhotos         int
  description         string
  priceLevel          string     [note: 'budget|mid|premium']
  openingHours        array      [note: '[{day,open,close,isOpen24,isClosed}]']
  isOpenNow           boolean
  highlights          string[]
  offerings           string[]
  serviceOptions      string[]
  accessibility       string[]

  // OPG marketplace flags
  acceptsWalkIn       boolean    [note: 'QR/manual check-in venue']
  hasClasses          boolean    [note: 'offers bookable timed slots']
  opg                 object     [note: '{isListed,isVerified,isPartner,isFeatured,planSlugs:[]}']

  // Quality & Search
  qualityScore        int        [note: '0-100 · indexed']
  scoreBreakdown      object
  dataCompleteness    int        [note: '0-100 · indexed']
  embedText           string     [note: 'Typesense semantic index']
  searchBoost         float      [note: 'manual rank boost · default 1.0']

  // Crawl
  crawl               object     [note: '{jobId,status,version,firstCrawledAt,lastCrawledAt,sourceUrl}']
  enrichment          object     [note: '{status,lastSuccess,lastAttempt,consecutiveErrors,error}']
  parsed              boolean

  createdVia          string     [note: 'usually crawler']
  deletedAt           datetime   [note: 'soft-delete']
  createdAt           datetime
  updatedAt           datetime
  indexes {
    (cityOpgId, primaryCategorySlug, qualityScore) [name: 'idx_city_cat_quality · core SEO+browse']
    (city, primaryCategorySlug)                    [name: 'idx_city_cat_display']
    (rating, qualityScore)                         [name: 'idx_rank']
  }
}

Table space_reviews {
  opgId          string   [pk, note: 'RVW-XXXX']
  _id            ObjectId [unique]
  spaceOpgId     string   [ref: > spaces.opgId, note: 'indexed']
  reviewId       string   [unique, note: 'Google review id · nullable · indexed']

  // Author — native reviews link to a real user + visit
  source         string   [note: 'google|opg · indexed']
  userOpgId      string   [note: 'cross-DB → core.users · nullable · opg-origin only']
  checkinOpgId   string   [note: 'cross-DB → core.checkins · proves visit · nullable']
  authorName     string   [note: 'google scrape · denorm display']
  authorUrl      string
  authorAvatar   string

  rating         float    [note: '1-5 · indexed']
  text           string
  photos         string[]
  publishedAtRaw string
  publishedAt    datetime [note: 'indexed']
  likes          int
  ownerReply     object   [note: '{text,publishedAt}']
  isVerified     boolean  [note: 'true if checkinOpgId present']
  isFlagged      boolean
  flagReason     string
  createdVia     string
  deletedAt      datetime
  createdAt      datetime
  updatedAt      datetime
  indexes {
    (spaceOpgId, publishedAt) [name: 'idx_space_recent']
    (spaceOpgId, rating)      [name: 'idx_space_rating']
  }
}

Table space_photos {
  opgId        string   [pk, note: 'PHT-XXXX']
  _id          ObjectId [unique]
  spaceOpgId   string   [ref: > spaces.opgId, note: 'indexed']
  assetOpgId   string   [ref: > media_assets.opgId, note: 'cross-DB']
  publicUrl    string   [note: 'denorm rendered url']
  thumbnailUrl string
  type         string   [note: 'cover|interior|exterior|equipment|general']
  width        int
  height       int
  order        int      [note: 'indexed']
  isCover      boolean
  createdVia   string
  deletedAt    datetime
  createdAt    datetime
}

Table space_chains {
  opgId         string   [pk, note: 'CHN-XXXX']
  _id           ObjectId [unique]
  slug          string   [unique]
  name          string
  description   string
  logoAssetOpgId string  [ref: > media_assets.opgId]
  logoUrl       string   [note: 'denorm']
  websiteUrl    string
  totalBranches int      [note: 'cached · cron']
  cityOpgIds    string[] [note: 'ref locations.opgId[]']
  isActive      boolean
  deletedAt     datetime
  createdAt     datetime
  updatedAt     datetime
}

Table space_categories {
  slug        string   [pk, note: 'natural PK e.g. hiit · indexed']
  _id         ObjectId [unique]
  key         string   [unique, note: 'snake_case']
  name        string
  description string
  color       string   [note: 'bg hex']
  accent      string   [note: 'text hex']
  imageUrl    string
  parentSlug  string   [ref: > space_categories.slug, note: 'nullable sub-cat']
  order       int
  isActive    boolean
  createdAt   datetime
  updatedAt   datetime
}

Table space_amenities {
  slug      string   [pk, note: 'natural PK e.g. air-conditioning · indexed']
  _id       ObjectId [unique]
  key       string   [unique, note: 'snake_case']
  name      string
  category  string   [note: 'equipment|facility|service|wellness']
  icon      string
  isActive  boolean
  createdAt datetime
  updatedAt datetime
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  CLUSTER: opg-core                                            ║
// ║  PII + money + operations. Strict IAM. Never exposed direct.  ║
// ╚══════════════════════════════════════════════════════════════╝

Table users {
  opgId        string    [pk, note: 'USR-XXXX · indexed']
  _id          ObjectId  [unique]
  email        string    [unique, note: 'indexed']
  phone        string    [note: 'E.164 · indexed']
  name         string
  avatarAssetOpgId string [ref: > media_assets.opgId]
  avatarUrl    string    [note: 'denorm']
  authProvider string    [note: 'email|google|apple|phone']
  authId       string    [unique, note: 'OAuth sub · indexed']
  role         string    [note: 'user|partner|admin|superadmin']
  cityOpgId    string    [note: 'cross-DB → atlas.locations · nullable']
  preferences  object    [note: '{notifications,newsletter,categories:[],units}']
  rewardBalance int      [note: 'denorm cache of rewards ledger · cron-verified']
  referralCode string    [unique, note: 'their own code · indexed']
  isActive     boolean
  isVerified   boolean
  lastLoginAt  datetime
  createdVia   string
  deletedAt    datetime
  createdAt    datetime
  updatedAt    datetime
}

Table devices {
  opgId         string   [pk, note: 'DEV-XXXX · mobile push routing']
  _id           ObjectId [unique]
  userOpgId     string   [ref: > users.opgId, note: 'nullable pre-login · indexed']
  platform      string   [note: 'ios|android|web · indexed']
  pushToken     string   [note: 'FCM/APNs · indexed']
  appVersion    string   [note: 'gates force-update']
  osVersion     string
  deviceModel   string
  notifPrefs    object    [note: '{push,promo,checkin,expiry}']
  lastSeenAt    datetime  [note: 'indexed · stale cleanup']
  isActive      boolean
  createdAt     datetime
  updatedAt     datetime
}

Table memberships {
  opgId        string   [pk, note: 'MBR-XXXX']
  _id          ObjectId [unique]
  userOpgId    string   [ref: > users.opgId, note: 'indexed']
  planOpgId    string   [note: 'cross-DB → content.plans']
  planSlug     string   [note: 'denorm']
  status       string   [note: 'active|paused|expired|cancelled · indexed']
  startedAt    datetime
  expiresAt    datetime [note: 'indexed · cron expiry']
  autoRenew    boolean
  cycleAnchor  datetime [note: 'credit reset day']
  pausedAt     datetime [note: 'nullable']
  cancelledAt  datetime [note: 'nullable']
  cancelReason string
  createdVia   string
  deletedAt    datetime
  createdAt    datetime
  updatedAt    datetime
}

Table pass_ledger {
  opgId          string   [pk, note: 'LDG-XXXX · the visit/credit balance system']
  _id            ObjectId [unique]
  membershipOpgId string  [ref: > memberships.opgId, note: 'indexed']
  userOpgId      string   [ref: > users.opgId, note: 'indexed']
  type           string   [note: 'grant|debit|hold|release|expire|rollover|refund · indexed']
  credits        int      [note: 'signed: +grant / -debit']
  balanceAfter   int      [note: 'running balance for this cycle']
  reason         string   [note: 'cycle_grant|checkin|booking|cancel|expiry']
  refType        string   [note: 'checkin|booking|null']
  refOpgId       string   [note: 'CHK-/BKG- that caused this entry']
  cycleStart     datetime
  cycleEnd       datetime [note: 'indexed · expiry sweep']
  createdAt      datetime [note: 'indexed']
  indexes {
    (membershipOpgId, createdAt) [name: 'idx_ledger_membership']
    (userOpgId, cycleEnd)        [name: 'idx_ledger_cycle']
  }
}

Table payments {
  opgId          string   [pk, note: 'PAY-XXXX']
  _id            ObjectId [unique]
  userOpgId      string   [ref: > users.opgId, note: 'indexed']
  membershipOpgId string  [ref: > memberships.opgId]
  invoiceOpgId   string   [ref: > invoices.opgId, note: 'nullable until issued']
  couponOpgId    string   [ref: > coupons.opgId, note: 'nullable']
  offerOpgId     string   [ref: > offers.opgId, note: 'nullable']
  amount         int      [note: 'INR paise · gross']
  discount       int      [note: 'INR paise · from coupon/offer']
  currency       string   [note: 'INR']
  gateway        string   [note: 'razorpay|upi_manual|stripe']
  gatewayTxnId   string   [unique, note: 'indexed']
  gatewayOrderId string
  upiRef         string
  status         string   [note: 'pending|success|failed|refunded · indexed']
  refundAmount   int      [note: 'nullable']
  refundedAt     datetime [note: 'nullable']
  createdVia     string
  paidAt         datetime
  createdAt      datetime
}

Table payment_events {
  opgId        string   [pk, note: 'PEV-XXXX · webhook idempotency store']
  _id          ObjectId [unique]
  gatewayEventId string [unique, note: 'dedupe key · indexed · stops double-credit']
  gateway      string
  eventType    string   [note: 'payment.captured|refund.processed|...']
  paymentOpgId string   [ref: > payments.opgId, note: 'resolved · nullable']
  rawPayload   object    [note: 'full webhook body']
  processed    boolean  [note: 'indexed']
  processedAt  datetime
  receivedAt   datetime [note: 'indexed']
}

Table invoices {
  opgId          string   [pk, note: 'INV-XXXX']
  _id            ObjectId [unique]
  invoiceNumber  string   [unique, note: 'SEQUENTIAL per FY (GST law) · the one counter']
  userOpgId      string   [ref: > users.opgId, note: 'indexed']
  paymentOpgId   string   [ref: > payments.opgId]
  membershipOpgId string  [ref: > memberships.opgId]
  invoiceDate    datetime [note: 'indexed']
  billingName    string
  billingGstin   string   [note: 'buyer GSTIN · nullable']
  placeOfSupply  string   [note: 'state code']
  lineItems      array    [note: '[{desc,hsnSac,qty,rate,amount}]']
  subtotal       int      [note: 'INR paise']
  cgst           int
  sgst           int
  igst           int
  total          int
  status         string   [note: 'issued|cancelled|credit_note · indexed']
  pdfAssetOpgId  string   [ref: > media_assets.opgId, note: 'rendered invoice']
  createdAt      datetime
}

Table checkins {
  opgId          string   [pk, note: 'CHK-XXXX']
  _id            ObjectId [unique]
  userOpgId      string   [ref: > users.opgId, note: 'indexed']
  spaceOpgId     string   [note: 'cross-DB → atlas.spaces · indexed']
  membershipOpgId string  [ref: > memberships.opgId]
  bookingOpgId   string   [ref: > bookings.opgId, note: 'nullable · set if from a class booking']
  ledgerOpgId    string   [ref: > pass_ledger.opgId, note: 'the debit entry']
  method         string   [note: 'qr|manual|partner_app|walk_in']
  verifiedBy     string   [note: 'system|partner|admin']
  checkedInAt    datetime [note: 'indexed · ARCHIVABLE']
  createdAt      datetime
  indexes {
    (userOpgId, checkedInAt)  [name: 'idx_checkin_user']
    (spaceOpgId, checkedInAt) [name: 'idx_checkin_space']
  }
}

Table classes {
  opgId         string   [pk, note: 'CLS-XXXX · a bookable class template']
  _id           ObjectId [unique]
  spaceOpgId    string   [note: 'cross-DB → atlas.spaces · indexed']
  partnerOpgId  string   [ref: > partners.opgId, note: 'who manages it']
  name          string
  categorySlug  string   [note: 'ref atlas.space_categories.slug']
  description   string
  durationMin   int
  capacity      int
  level         string   [note: 'beginner|intermediate|advanced']
  instructorName string
  creditsRequired int    [note: 'debits pass_ledger on booking']
  isActive      boolean
  deletedAt     datetime
  createdVia    string
  createdAt     datetime
  updatedAt     datetime
}

Table schedules {
  opgId         string   [pk, note: 'SCH-XXXX · concrete time slot of a class']
  _id           ObjectId [unique]
  classOpgId    string   [ref: > classes.opgId, note: 'indexed']
  spaceOpgId    string   [note: 'cross-DB → atlas.spaces · indexed denorm']
  startAt       datetime [note: 'indexed']
  endAt         datetime
  recurrenceId  string   [note: 'groups a recurring series · nullable']
  capacity      int      [note: 'override class.capacity']
  bookedCount   int      [note: 'denorm · cron-safe via $inc']
  waitlistCount int
  instructorName string
  status        string   [note: 'scheduled|full|cancelled|completed · indexed']
  createdAt     datetime
  updatedAt     datetime
  indexes {
    (spaceOpgId, startAt) [name: 'idx_sched_space_time']
    (classOpgId, startAt) [name: 'idx_sched_class_time']
  }
}

Table bookings {
  opgId          string   [pk, note: 'BKG-XXXX · slot reservation (≠ checkin)']
  _id            ObjectId [unique]
  userOpgId      string   [ref: > users.opgId, note: 'indexed']
  scheduleOpgId  string   [ref: > schedules.opgId, note: 'the slot · indexed']
  classOpgId     string   [ref: > classes.opgId]
  spaceOpgId     string   [note: 'cross-DB → atlas.spaces · denorm']
  membershipOpgId string  [ref: > memberships.opgId]
  ledgerOpgId    string   [ref: > pass_ledger.opgId, note: 'hold/debit entry']
  checkinOpgId   string   [ref: > checkins.opgId, note: 'set when they show · nullable']
  status         string   [note: 'confirmed|waitlisted|cancelled|completed|no_show · indexed']
  slotStart      datetime [note: 'denorm · indexed']
  bookedAt       datetime
  cancelledAt    datetime [note: 'nullable']
  cancelReason   string
  createdVia     string
  createdAt      datetime
  indexes {
    (userOpgId, slotStart)     [name: 'idx_booking_user']
    (scheduleOpgId, status)    [name: 'idx_booking_slot']
  }
}

// ── Partner integration (normalized: business stored ONCE) ──────────
Table partners {
  opgId          string   [pk, note: 'PTR-XXXX · the BUSINESS entity']
  _id            ObjectId [unique]
  ownerUserOpgId string   [ref: > users.opgId, note: 'indexed']
  businessName   string   [note: 'stored once · not per location']
  legalName      string
  gstNumber      string   [note: 'stored once']
  pan            string
  status         string   [note: 'pending|active|suspended|churned · indexed']
  tier           string   [note: 'basic|featured|premium']
  defaultCommissionPct float [note: 'overridable per space']
  contactName    string
  contactPhone   string
  contactEmail   string
  contractAssetOpgId string [ref: > media_assets.opgId, note: 'signed agreement']
  fromLeadOpgId  string   [ref: > leads.opgId, note: 'acquisition trace · nullable']
  signedAt       datetime
  activatedAt    datetime
  createdVia     string
  deletedAt      datetime
  createdAt      datetime
  updatedAt      datetime
}

Table partner_spaces {
  opgId          string   [pk, note: 'PSP-XXXX · partner ↔ space link (M:N)']
  _id            ObjectId [unique]
  partnerOpgId   string   [ref: > partners.opgId, note: 'indexed']
  spaceOpgId     string   [note: 'cross-DB → atlas.spaces · indexed']
  isPrimary      boolean  [note: 'flagship location']
  status         string   [note: 'active|paused · per-location override']
  commissionPct  float    [note: 'override · nullable → inherits partner default']
  managerName    string
  managerPhone   string
  payoutAccount  object   [note: '{upiId,bankRef} · per-location payouts']
  activatedAt    datetime
  deletedAt      datetime
  createdAt      datetime
  updatedAt      datetime
  indexes {
    (partnerOpgId, spaceOpgId) [unique, name: 'uniq_partner_space']
  }
}

// ── Growth: offers / coupons / referrals / rewards / leads / profiler ──
Table offers {
  opgId        string   [pk, note: 'OFR-XXXX · campaign']
  _id          ObjectId [unique]
  slug         string   [unique]
  title        string
  description  string
  type         string   [note: 'percentage|flat|free_trial|bogo']
  value        int      [note: 'pct or INR paise']
  appliesTo    string   [note: 'plan|space|category|all']
  targetOpgIds string[] [note: 'plan/space/category targets']
  audience     string   [note: 'all|new|user|partner']
  terms        string
  startsAt     datetime
  endsAt       datetime [note: 'indexed']
  isActive     boolean
  createdVia   string
  createdAt    datetime
  updatedAt    datetime
}

Table coupons {
  opgId          string   [pk, note: 'CPN-XXXX · redeemable code']
  _id            ObjectId [unique]
  code           string   [unique, note: 'indexed']
  offerOpgId     string   [ref: > offers.opgId, note: 'parent campaign · nullable']
  type           string   [note: 'percentage|flat']
  value          int
  minAmount      int      [note: 'INR paise']
  maxRedemptions int      [note: 'global cap']
  redemptionCount int     [note: 'denorm · $inc on redeem']
  perUserLimit   int
  applicablePlanOpgIds string[]
  validFrom      datetime
  validTo        datetime [note: 'indexed']
  isActive       boolean
  createdAt      datetime
}

Table coupon_redemptions {
  opgId        string   [pk, note: 'CRD-XXXX · enforces perUserLimit']
  _id          ObjectId [unique]
  couponOpgId  string   [ref: > coupons.opgId, note: 'indexed']
  userOpgId    string   [ref: > users.opgId, note: 'indexed']
  paymentOpgId string   [ref: > payments.opgId]
  redeemedAt   datetime
  indexes {
    (couponOpgId, userOpgId) [name: 'idx_redeem_peruser']
  }
}

Table referrals {
  opgId           string   [pk, note: 'REF-XXXX']
  _id             ObjectId [unique]
  code            string   [note: 'referrer code used · indexed']
  referrerUserOpgId string [ref: > users.opgId, note: 'indexed']
  refereeUserOpgId  string [ref: > users.opgId, note: 'nullable until signup']
  status          string   [note: 'pending|signed_up|converted|rewarded · indexed']
  channel         string   [note: 'whatsapp|link|qr']
  rewardOpgId     string   [ref: > rewards.opgId, note: 'payout entry · nullable']
  convertedAt     datetime
  createdAt       datetime
}

Table rewards {
  opgId        string   [pk, note: 'RWD-XXXX · loyalty POINTS ledger']
  _id          ObjectId [unique]
  userOpgId    string   [ref: > users.opgId, note: 'indexed']
  type         string   [note: 'earn|redeem|expire|adjust · indexed']
  points       int      [note: 'signed']
  balanceAfter int      [note: 'running balance']
  source       string   [note: 'referral|checkin_streak|signup|promo|redemption']
  refType      string   [note: 'referral|reward_item|checkin|null']
  refOpgId     string
  rewardItemOpgId string [note: 'cross-DB → content.reward_items · nullable']
  expiresAt    datetime [note: 'indexed · expiry sweep']
  createdAt    datetime [note: 'indexed']
  indexes {
    (userOpgId, createdAt) [name: 'idx_rewards_user']
  }
}

Table leads {
  opgId        string   [pk, note: 'LED-XXXX · top of partner/user funnel']
  _id          ObjectId [unique]
  type         string   [note: 'partner|user · indexed']
  businessName string   [note: 'partner leads']
  contactName  string
  phone        string   [note: 'indexed']
  email        string
  cityOpgId    string   [note: 'cross-DB → atlas.locations']
  message      string
  source       string   [note: 'for-gyms|profiler|contact|import · indexed']
  status       string   [note: 'new|contacted|qualified|converted|lost · indexed']
  assignedTo   string   [note: 'admin USR- · nullable']
  notes        array    [note: '[{by,text,at}]']
  convertedPartnerOpgId string [ref: > partners.opgId, note: 'nullable']
  convertedUserOpgId    string [ref: > users.opgId, note: 'nullable']
  createdVia   string
  createdAt    datetime
  updatedAt    datetime
}

Table profiler_results {
  opgId        string   [pk, note: 'PRF-XXXX · /fitness-profiler — highest intent']
  _id          ObjectId [unique]
  userOpgId    string   [ref: > users.opgId, note: 'nullable · anon until signup']
  sessionId    string   [note: 'pre-auth stitch key · indexed']
  answers      object   [note: 'raw quiz responses']
  derivedGoals string[] [note: 'weight_loss|strength|flexibility|...']
  recommendedCategorySlugs string[]
  recommendedPlanOpgId     string [note: 'cross-DB → content.plans']
  recommendedSpaceOpgIds   string[] [note: 'cross-DB → atlas.spaces']
  convertedToLead       boolean
  convertedToMembership boolean
  source       string
  createdVia   string
  createdAt    datetime
}

Table saves {
  opgId      string   [pk, note: 'SAV-XXXX · replaces users.savedSpaces[]']
  _id        ObjectId [unique]
  userOpgId  string   [ref: > users.opgId, note: 'indexed']
  spaceOpgId string   [note: 'cross-DB → atlas.spaces · indexed']
  list       string   [note: 'named collection e.g. wishlist · default "saved"']
  createdAt  datetime
  indexes {
    (userOpgId, spaceOpgId) [unique, name: 'uniq_user_save']
  }
}

Table notifications {
  opgId      string   [pk, note: 'NTF-XXXX']
  _id        ObjectId [unique]
  userOpgId  string   [ref: > users.opgId, note: 'indexed']
  deviceOpgId string  [ref: > devices.opgId, note: 'nullable · push target']
  type       string   [note: 'membership_expiry|payment_success|checkin|booking|promo']
  channel    string   [note: 'push|email|sms|in_app']
  title      string
  body       string
  data       object   [note: 'deep link payload']
  isRead     boolean  [note: 'indexed']
  sentAt     datetime
  readAt     datetime [note: 'nullable']
  createdAt  datetime [note: 'ARCHIVABLE']
}

Table audit_logs {
  opgId      string   [pk, note: 'AUD-XXXX']
  _id        ObjectId [unique]
  actorOpgId string   [ref: > users.opgId]
  actorRole  string   [note: 'user|partner|admin|system']
  action     string   [note: 'membership.cancel|payment.refund|...']
  entityType string   [note: 'polymorphic label']
  entityOpgId string  [note: 'polymorphic target · note-only ref']
  diff       object   [note: '{before,after}']
  ip         string
  userAgent  string
  createdAt  datetime [note: 'indexed · TTL 90d (already cold)']
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  CLUSTER: opg-content  (CMS + Blog merged)                    ║
// ║  Public-read. Merge lets posts $lookup author/category        ║
// ║  → v4's duplicated author{}/category{} objects removed.       ║
// ╚══════════════════════════════════════════════════════════════╝

Table pages {
  opgId         string   [pk, note: 'PGE-XXXX']
  _id           ObjectId [unique]
  route         string   [unique, note: 'e.g. / · /for-gyms · indexed']
  title         string
  subtitle      string
  cta_primary   object   [note: '{label,href,variant}']
  cta_secondary object   [note: '{label,href,variant}']
  ogAssetOpgId  string   [ref: > media_assets.opgId]
  seo           object   [note: '{metaTitle,metaDesc,keywords,ogImage,canonical,noindex,schemaType}']
  isActive      boolean
  deletedAt     datetime
  updatedAt     datetime
}

Table widgets {
  opgId     string   [pk, note: 'WGT-XXXX · Blueprint + Page Slot Override']
  _id       ObjectId [unique]
  slug      string   [unique, note: 'indexed']
  type      string   [note: 'faq|steps|benefits|stats|banner|testimonials|grid|cta']
  pageOpgId string   [ref: > pages.opgId, note: 'indexed']
  pageRoute string   [note: 'denorm fast lookup']
  title     string
  subtitle  string
  items     array    [note: 'shape varies by type']
  config    object   [note: '{columns,theme,showIcons,background}']
  order     int
  isActive  boolean
  updatedAt datetime
}

Table faqs {
  opgId        string   [pk, note: 'FAQ-XXXX']
  _id          ObjectId [unique]
  slug         string   [unique, note: 'indexed']
  question     string
  answer       string
  page         string   [note: 'home|for-gyms|pricing|blog · indexed']
  audience     string   [note: 'user|partner|both']
  tags         string[]
  order        int
  seoInclude   boolean
  active       boolean
  helpful      object   [note: '{yes,no} · cron']
  relatedSlugs string[]
  createdAt    datetime
  updatedAt    datetime
}

Table plans {
  opgId         string   [pk, note: 'PLN-XXXX']
  _id           ObjectId [unique]
  slug          string   [unique, note: 'starter|pro|elite']
  name          string
  tagline       string
  badge         string   [note: 'nullable']
  price_monthly int      [note: 'INR paise']
  price_annual  int
  currency      string   [note: 'INR']
  billingCycles string[] [note: 'monthly|annual|quarterly']
  features      array    [note: '[{label,included,highlight}]']
  limits        object   [note: '{visitsPerMonth,classCredits,citiesAccess,guestPasses}']
  cta_label     string
  cta_href      string
  isFeatured    boolean
  isActive      boolean
  order         int
  updatedAt     datetime
}

Table testimonials {
  opgId        string   [pk, note: 'TST-XXXX']
  _id          ObjectId [unique]
  name         string
  city         string
  avatarAssetOpgId string [ref: > media_assets.opgId]
  avatarUrl    string   [note: 'denorm']
  rating       float
  text         string
  planOpgId    string   [ref: > plans.opgId]
  spaceOpgId   string   [note: 'cross-DB → atlas.spaces · nullable']
  userOpgId    string   [note: 'cross-DB → core.users · nullable']
  source       string   [note: 'manual|google|import']
  order        int
  isActive     boolean
  createdAt    datetime
}

Table city_guides {
  opgId           string   [pk, note: 'CTY-XXXX']
  _id             ObjectId [unique]
  locationOpgId   string   [note: 'cross-DB → atlas.locations · canonical tie']
  citySlug        string   [unique, note: 'indexed e.g. delhi']
  cityName        string
  state           string
  heroTitle       string
  heroSubtitle    string
  introPara       string
  topCategories   string[] [note: 'ref atlas.space_categories.slug[]']
  spaceCount      int      [note: 'cached · cron']
  coverAssetOpgId string   [ref: > media_assets.opgId]
  seo             object   [note: '{metaTitle,metaDesc,keywords,ogImage,canonical}']
  faqs            array    [note: '[{question,answer,order}]']
  isActive        boolean
  updatedAt       datetime
}

Table banners {
  opgId      string   [pk, note: 'BNR-XXXX']
  _id        ObjectId [unique]
  slug       string   [unique]
  placement  string   [note: 'homepage|search-top|space-page|global|city-page|app-home']
  priority   int
  title      string
  body       string
  cta        object   [note: '{label,href,variant}']
  offerOpgId string   [note: 'cross-DB → core.offers · nullable']
  imageAssetOpgId string [ref: > media_assets.opgId]
  imageUrl   string   [note: 'denorm']
  bgColor    string
  audience   string   [note: 'all|user|partner|guest']
  platform   string   [note: 'all|web|mobile']
  startsAt   datetime
  endsAt     datetime
  isActive   boolean
}

Table nav_config {
  opgId        string   [pk, note: 'NAV-XXXX']
  _id          ObjectId [unique]
  version      int      [note: 'increment → cache bust']
  desktopLinks array    [note: '[{label,href,isCta,isExternal,order}]']
  bottomNav    array    [note: '[{label,href,icon,order}] · mobile']
  footer       object   [note: '{columns,copyright,socialLinks}']
  updatedAt    datetime
}

Table redirects {
  opgId      string   [pk, note: 'RDR-XXXX']
  _id        ObjectId [unique]
  from       string   [unique, note: 'source path · indexed']
  to         string
  statusCode int      [note: '301|302']
  reason     string   [note: 'slug-change|deprecated|seo']
  isActive   boolean
  createdAt  datetime
}

Table app_config {
  opgId            string   [pk, note: 'CFG-XXXX · mobile remote config']
  _id              ObjectId [unique]
  key              string   [unique, note: 'indexed']
  platform         string   [note: 'ios|android|all']
  minSupportedVersion string [note: 'below → force update']
  latestVersion    string
  forceUpdate      boolean
  maintenanceMode  boolean
  featureFlags     object   [note: '{flagName:bool}']
  value            object   [note: 'arbitrary config payload']
  updatedAt        datetime
}

Table reward_items {
  opgId       string   [pk, note: 'RWI-XXXX · points → redeemable catalog']
  _id         ObjectId [unique]
  slug        string   [unique]
  name        string
  description string
  pointsCost  int
  type        string   [note: 'discount|free_pass|merch|partner_perk']
  value       object   [note: 'shape varies by type']
  stock       int      [note: 'nullable = unlimited']
  imageAssetOpgId string [ref: > media_assets.opgId]
  isActive    boolean
  createdAt   datetime
  updatedAt   datetime
}

// ── Blog (merged in — refs resolve via $lookup, no nested dupes) ────
Table posts {
  opgId           string    [pk, note: 'PST-XXXX']
  _id             ObjectId  [unique]
  slug            string    [unique, note: 'indexed']
  title           string
  status          string    [note: 'draft|published|archived · indexed']
  excerpt         string
  body            string    [note: 'MDX/Markdown']
  tableOfContents array     [note: '[{id,title,level,anchor}]']
  readingTime     int
  wordCount       int

  // Relations — refs only. v4 nested author{}/category{} REMOVED ($lookup now).
  categoryOpgId   string    [ref: > blog_categories.opgId]
  authorOpgId     string    [ref: > blog_authors.opgId]
  tagOpgIds       string[]  [note: 'ref blog_tags.opgId[]']

  // Media
  coverAssetOpgId string    [ref: > media_assets.opgId]
  coverUrl        string    [note: 'denorm rendered url only']
  ogImageUrl      string    [note: 'denorm']

  // SEO
  seo             object    [note: '{metaTitle,metaDesc,keywords,focusKeyword,canonical,noindex,seoScore,ogType,twitterCard,breadcrumbs}']

  // Interlinking
  faqs            array     [note: '[{question,answer}]']
  internalLinks   array     [note: '[{text,href,type}]']
  relatedPostOpgIds  string[]
  spaceOpgIds     string[]  [note: 'cross-DB → atlas.spaces · mentions']
  cityGuideOpgIds string[]  [ref: > city_guides.opgId, note: 'same-DB']
  categoryLinks   string[]  [note: 'ref atlas.space_categories.slug[]']

  // Engagement (counts via cron / $inc)
  featured        boolean
  trending        boolean
  editorsPick     boolean
  views           int
  shares          int
  bookmarks       int

  // AI
  ai              object    [note: '{summary,entities,topics,keyTakeaways,embedText}']

  createdVia      string
  deletedAt       datetime
  publishedAt     datetime  [note: 'indexed']
  updatedAt       datetime
  indexes {
    (status, publishedAt) [name: 'idx_post_published']
    (categoryOpgId, status) [name: 'idx_post_category']
  }
}

Table blog_categories {
  opgId       string   [pk, note: 'BCA-XXXX']
  _id         ObjectId [unique]
  slug        string   [unique, note: 'indexed']
  name        string
  description string
  color       string
  accent      string
  imageUrl    string
  order       int
  isActive    boolean
  createdAt   datetime
  updatedAt   datetime
}

Table blog_authors {
  opgId       string   [pk, note: 'ATH-XXXX']
  _id         ObjectId [unique]
  slug        string   [unique]
  name        string
  bio         string
  avatarAssetOpgId string [ref: > media_assets.opgId]
  avatarUrl   string   [note: 'denorm']
  expertise   string[]
  social      object   [note: '{twitter,linkedin,instagram}']
  isActive    boolean
  createdAt   datetime
  updatedAt   datetime
}

Table blog_tags {
  opgId     string   [pk, note: 'TAG-XXXX']
  _id       ObjectId [unique]
  slug      string   [unique, note: 'indexed']
  name      string
  isActive  boolean
  createdAt datetime
  updatedAt datetime
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  CLUSTER: opg-media                                           ║
// ║  Single source of truth for assets. Other DBs store only      ║
// ║  assetOpgId + the rendered url they actually display.         ║
// ╚══════════════════════════════════════════════════════════════╝

Table media_assets {
  opgId        string   [pk, note: 'AST-XXXX · cross-DB stable ref · indexed']
  _id          ObjectId [unique]
  ownerOpgId   string   [note: 'polymorphic · SPC-|USR-|PST-|PTR-|null · note-only']
  ownerType    string   [note: 'space|user|post|cms|partner|category|invoice']
  bucket       string   [note: 'spaces|avatars|covers|blog|cms|partners|invoices']
  publicUrl    string   [unique, note: 'CDN url · indexed']
  thumbnailUrl string
  originalUrl  string
  filename     string
  mimeType     string   [note: 'image/jpeg|webp|png|avif|application/pdf']
  width        int
  height       int
  sizeBytes    int
  aspectRatio  string   [note: 'computed']
  altText      string
  caption      string
  tags         string[]
  source       string   [note: 'crawl|partner_upload|admin_upload|ai_generated|system']
  usageCount   int      [note: 'orphan detection · cron']
  isActive     boolean
  createdVia   string
  deletedAt    datetime
  createdAt    datetime
  updatedAt    datetime
}

Table media_variants {
  opgId      string   [pk, note: 'VAR-XXXX']
  _id        ObjectId [unique]
  assetOpgId string   [ref: > media_assets.opgId, note: 'indexed']
  variantType string  [note: 'thumbnail|og|card|hero|avatar|blur']
  publicUrl  string
  width      int
  height     int
  sizeBytes  int
  format     string   [note: 'webp|jpeg|avif']
  createdAt  datetime
}


// ╔══════════════════════════════════════════════════════════════╗
// ║  ARCHIVAL LAYER (cold)  —  ENHANCEMENT / NOT WIRED TO HOT PATH ║
// ║  Hot tables stay as-is now. A migration job later moves cold   ║
// ║  rows here. checkins is the candidate for a time-series        ║
// ║  collection (bucketed by checkedInAt). Same opgId is preserved ║
// ║  so historical refs never break.                               ║
// ╚══════════════════════════════════════════════════════════════╝

Table archival_jobs {
  opgId        string   [pk, note: 'ARJ-XXXX · tracks what was moved']
  _id          ObjectId [unique]
  sourceColl   string   [note: 'checkins|notifications|space_reviews|payment_events']
  cutoffBefore datetime [note: 'rows older than this archived']
  movedCount   int
  status       string   [note: 'running|done|failed']
  startedAt    datetime
  finishedAt   datetime
}

Table checkins_archive {
  opgId          string   [pk, note: 'mirrors checkins · same CHK- id']
  _id            ObjectId [unique]
  userOpgId      string
  spaceOpgId     string
  membershipOpgId string
  bookingOpgId   string
  method         string
  checkedInAt    datetime [note: 'time-series candidate · bucket key']
  archivedAt     datetime
  Note: 'Convert to MongoDB time-series collection: timeField=checkedInAt, metaField=spaceOpgId'
}

Table notifications_archive {
  opgId      string   [pk, note: 'mirrors notifications · same NTF- id']
  _id        ObjectId [unique]
  userOpgId  string
  type       string
  channel    string
  isRead     boolean
  sentAt     datetime
  archivedAt datetime
}

Table reviews_archive {
  opgId       string   [pk, note: 'mirrors space_reviews · same RVW- id']
  _id         ObjectId [unique]
  spaceOpgId  string
  source      string
  rating      float
  publishedAt datetime
  archivedAt  datetime
  Note: 'Archive only google-source stale reviews; keep opg-native hot'
}

Table payment_events_archive {
  opgId          string   [pk, note: 'mirrors payment_events · same PEV- id']
  _id            ObjectId [unique]
  gatewayEventId string
  gateway        string
  eventType      string
  receivedAt     datetime
  archivedAt     datetime
  Note: 'Idempotency events go cold fast — archive after settlement window'
}


// ── Visual grouping ────────────────────────────────────────────────
TableGroup opg_atlas {
  locations
  spaces
  space_reviews
  space_photos
  space_chains
  space_categories
  space_amenities
}

TableGroup opg_core {
  users
  devices
  memberships
  pass_ledger
  payments
  payment_events
  invoices
  checkins
  classes
  schedules
  bookings
  partners
  partner_spaces
  offers
  coupons
  coupon_redemptions
  referrals
  rewards
  leads
  profiler_results
  saves
  notifications
  audit_logs
}

TableGroup opg_content {
  pages
  widgets
  faqs
  plans
  testimonials
  city_guides
  banners
  nav_config
  redirects
  app_config
  reward_items
  posts
  blog_categories
  blog_authors
  blog_tags
}

TableGroup opg_media {
  media_assets
  media_variants
}

TableGroup opg_archival_cold {
  archival_jobs
  checkins_archive
  notifications_archive
  reviews_archive
  payment_events_archive
}