---
name: proof-listing
description: Audit a live Airbnb listing against its unit brief. Fetches the live Hospitable direct booking page, compares it to the unit brief, and outputs a prioritized report of critical issues, minor issues, and missing sections.
---

Audit the live Airbnb listing for the unit label given as the argument (e.g. "4-L", "21-I").

## STEP 1 — Load unit data

Read /Users/yasserkhan/airbnb-autohost2/data/unit-profiles.json.
Find the entry whose key matches the unit label argument (e.g. "4-L").
Extract:
- direct_booking_url
- floor
- bedrooms
- bed_type
- bathroom_type
- outdoor
- workspace (true/false)
- ceiling_fan (true/false)
- ethernet (true/false)
- trash_compactor (true/false)
- amenities.keep (list of amenity slugs that SHOULD be enabled)
- amenities.remove (list of amenity slugs that must NOT be enabled)

## STEP 2 — Load the unit brief

Read /Users/yasserkhan/airbnb-autohost2/.claude/listing-briefs/[unit].md (replace [unit] with the argument).
Extract:
- Max guests
- Key fob fee ($150)
- The DO NOT ENABLE amenity list
- The AMENITIES TO ENABLE list

## STEP 3 — Fetch the live listing

Fetch the direct_booking_url using WebFetch.
Extract all visible text content from the page including:
- Listing title
- Description / About this space
- The Space section
- Guest Access section
- Neighborhood section
- Getting Around section
- Directions section (check-in instructions)
- Other Details / Other Things to Note section
- House Rules
- Amenities shown as enabled
- Photo captions (alt text or visible caption text)
- Checkout instructions if visible

## STEP 4 — Run the audit

Compare the fetched live content against the unit brief and flag issues.

### CRITICAL issues (wrong info going to guests right now):
- Floor number stated incorrectly (e.g. says "5th floor" but brief says floor 4)
- Bed type stated incorrectly (e.g. says "Queen" but brief says "King")
- Bathroom type stated incorrectly (e.g. says "bathtub" for a walk-in shower only unit)
- Bedroom count stated incorrectly (critical for 21-I which is 2BR)
- Any amenity from the DO NOT ENABLE list is showing as enabled on the live listing
  (e.g. bathtub enabled for 4-L, ethernet enabled for 21-I)
- Directions section contains neighborhood info or Getting Around info
  (it should ONLY contain self check-in instructions and floor/unit number)
- HVAC text present but doesn't contain the exact required wording:
  Required: "The building utilizes a centralized HVAC system that operates in seasonal heating or cooling modes. During spring and fall transitions, temperature settings may be limited by the building's current operating mode."
  OR the older locked version: "Locate the radiation unit underneath the window in each room. On top of the radiation unit, find the square panel. Press the back two corners of the square panel"
  Flag if neither version is present at all.
- Key fob fee missing from checkout instructions or Other Details
  (must include "$150" and "key fob")
- Max guests set higher than what the brief specifies

### MINOR issues (suboptimal but not factually wrong):
- Photo captions are literal descriptions instead of benefit-focused
  (flag captions that describe objects: "gray sofa", "white wall", "window", "bed"
   without describing the guest benefit or experience)
- Photo captions over 100 characters
- Photo captions that use banned words: "cozy", "beautiful", "stunning", "amazing", "gorgeous"
- Title over 50 characters
- Description over 500 characters
- Neighborhood section doesn't mention FIFA World Cup 2026
- Getting Around section doesn't mention MARTA Peachtree Center Station
- Getting Around section says "3 minute walk" to MARTA — verify this is present
- Directions section is longer than 2-3 sentences (should be very short)
- Parking disclaimer not present in Other Details

### MISSING sections (fields that appear empty or not filled):
- Title empty or appears to be a default/placeholder
- Description empty
- The Space section empty or very short (under 100 words)
- Guest Access section empty
- Neighborhood section empty
- Getting Around section empty
- Directions section empty
- Other Details / Other Things to Note section empty
- House Rules not visible
- Checkout instructions not visible or missing key fob language
- Amenities section empty

## STEP 5 — Output the report

Format the report exactly as follows:

---
# Proof Report — Unit [UNIT] | [DATE]
Live URL: [direct_booking_url]

## CRITICAL ISSUES — Fix immediately
[List each critical issue with the specific wrong text found vs. what it should be.
If no critical issues: "None found ✓"]

## MINOR ISSUES — Fix when possible
[List each minor issue with location and what to change.
If no minor issues: "None found ✓"]

## MISSING SECTIONS — Fill these in
[List each section that appears empty or missing.
If nothing missing: "All sections present ✓"]

## SUMMARY
[1-2 sentences: overall listing health, most urgent thing to fix first]
---

If WebFetch cannot load the direct booking URL (e.g. auth wall, redirect, or timeout),
report: "Could not fetch live listing from [url] — the Hospitable direct booking page
may require authentication or be unavailable. Load it manually in a browser and
paste the text content here to continue the audit."

Example: /proof-listing 4-L
Example: /proof-listing 21-I
Example: "Proof the 23-N listing"
Example: "Run proof-listing for 21-I"
