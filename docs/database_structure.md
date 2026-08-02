# Database Structure

The `atlas` database has been normalized for scale and performance. We have moved from a single massive `gyms` document to a relational model using MongoDB references and `$lookup`s.

This prevents the `gyms` collection from hitting MongoDB's 16MB document size limits, improves query performance across indexable sub-records (like Photos or Reviews), and normalizes identical static data (Amenities and Categories) across thousands of gyms.

## Collections Map

1. **`gyms` (Target Collection)**
   - **Purpose**: Core identity and indexing. 
   - **Stores**: `placeId`, `name`, `slug`, `location`, `rating`, `totalReviews`.
   - **Foreign Keys**: `categoryId` (→ `gym_categories`), `amenityIds` (→ `gym_amenities`). 

2. **`gym_reviews`**
   - **Purpose**: Scalable user reviews.
   - **Stores**: Each document is one review by an author.
   - **Foreign Key**: `gymId` (→ `gyms`).
   
3. **`gym_photos`**
   - **Purpose**: Downloaded media scaling.
   - **Stores**: One document per photo URL and sizing information.
   - **Foreign Key**: `gymId` (→ `gyms`).

4. **`gym_crawl_meta`**
   - **Purpose**: Data pipeline provenance.
   - **Stores**: A 1:1 relationship containing crawl history, job IDs, timestamp completeness scores.
   - **Foreign Key**: `gymId` (→ `gyms`).

5. **`gym_categories` (Static Dictionary)**
   - **Purpose**: Normalized gym categories.
   - **Stores**: `label`, `slug` ("gym", "yoga-studio"). Seeded statically.

6. **`gym_place_types` (Static Dictionary)**
   - **Purpose**: Internal Google mappings.
   - **Stores**: `googleType` mappings vs app `slug`.

7. **`gym_amenities` (Static Dictionary)**
   - **Purpose**: A growing dictionary of distinct facility amenities.
   - **Stores**: `label`, `slug` ("locker-rooms", "wifi"). Linked multiple times to different gyms.

## Query Approaches

**Mongoose Ref Integration**
To fetch a fully populated gym document, the application uses Mongoose `populate`. 

```javascript
// Example lookup equivalent (or populated)
const gym = await Gym.findById(targetId)
  .populate('amenities')
  .populate('category');
  
const reviews = await Review.find({ gymId: targetId });
const photos = await Photo.find({ gymId: targetId });
```

This ensures endpoints cleanly assemble the normalized components before returning to the web client.
