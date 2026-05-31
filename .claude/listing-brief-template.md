# Airbnb Listing Brief — Master Template
# Peachtree Tower Rentals | 300 Peachtree Road NE, Atlanta, GA

This file is the master prompt template for filling out any Airbnb listing in this portfolio.
Paste the relevant per-unit brief (`.claude/listing-briefs/[unit].md`) at the start of your Chrome session before touching any field.

---

## GLOBAL RULES — NEVER VIOLATE THESE

1. **Photo captions must match the photo.** Read every photo before writing its caption. Never guess what's in a photo. Never copy captions from another unit.
2. **Never put Getting Around content in Directions.** Directions = how to enter the building and unit. Getting Around = transportation options nearby. They are separate Airbnb fields.
3. **Always include the key fob return note in House Rules / Other Things to Note.** Exact text: *"A $[FEE] key fob replacement fee applies if the fob is not returned at checkout."*
4. **HVAC description is locked.** Never paraphrase the HVAC text (see below). Copy it word-for-word into "The Space" or "Other Things to Note" as instructed.
5. **Parking disclaimer is locked.** Never paraphrase the parking disclaimer (see below). It must appear verbatim wherever parking is mentioned.
6. **Title ≤ 50 characters.** Count every character including spaces before saving.
7. **No invented facts.** If a unit detail isn't in the brief, leave the field blank or ask. Do not infer.
8. **Sign-off is always "Cal".** Never use "Yasser", "the host", or any other name.

---

## AIRBNB LISTING EDITOR — FIELD-BY-FIELD INSTRUCTIONS

### 1. Title
- Maximum 50 characters (Airbnb hard limit — it will truncate silently)
- Must include: neighborhood anchor (Downtown/Midtown), unit type (1BR/2BR), one differentiator (floor/views/sqft)
- For World Cup 2026 listings: lead with the World Cup angle
- Do NOT use: generic words like "cozy", "beautiful", "stunning" — use specific facts
- Template: `[WC angle or location] [unit type] [differentiator]`
- Example: `Hotel District 1BR | Steps to Arena`

### 2. Description (Summary / About this space)
- 2–3 sentences max visible above the fold
- Lead with the single strongest selling point for that unit (floor height, sqft, location proximity)
- Second sentence: the guest experience (what it feels like to be there)
- Third sentence (optional): World Cup 2026 / event hook if relevant
- Do NOT repeat the title. Do NOT list amenities here.

### 3. The Space
Structure exactly as follows — use these exact section headers:

```
The Space

[2–3 sentence overview of the physical unit — size, layout, feel]

Bedroom
[Bed type, size, any notable features — e.g., blackout curtains, city views from bed]

Living Area
[Sofa, TV, smart TV, work desk if present]

Kitchen
[Full kitchen equipment — stove, oven, microwave, dishwasher, coffee maker, etc.]

Bathroom
[EXACT bathroom type from unit brief — do not paraphrase or invent]

[OUTDOOR SECTION — only if unit has outdoor space]
Outdoor Space
[Patio/balcony description with view direction and what's visible]

Heating & Cooling
To adjust the heating and cooling, follow these steps:

Seasonal adjustment: As mentioned in the listing, the heating/cooling functions change with the seasons. In spring and summer you can adjust the A/C, while in late fall and winter you can adjust the heating controls.

Accessing controls: Locate the radiation unit underneath the window in each room.

Panel access: On top of the radiation unit, find the square panel.

Activating controls: Press the back two corners of the square panel to display the fan adjustment controls.

By following these steps, you can access and adjust the heating and cooling according to your needs.

Laundry
Washer and dryer available in the building for guest use.

[WORKSPACE SECTION — only if unit has workspace: true]
Workspace
The unit includes a dedicated workspace, suitable for remote work.

[ETHERNET SECTION — only if unit has ethernet: true]
High-Speed Internet
Gigabit ethernet connection available in addition to WiFi.

[TRASH COMPACTOR SECTION — only if unit has trash_compactor: true]
In-Unit Trash Compactor
The unit is equipped with an in-unit trash compactor for convenience.
```

### 4. Guest Access
Structure exactly as follows:

```
Guests have full private access to the entire unit for the duration of their stay, including:

- The unit itself (floor [FLOOR], unit [UNIT_LABEL])
- Private [patio/balcony] with city views
- Building amenities: elevator, 24-hour security desk, building lobby
- In-building washer and dryer

Self check-in via [METHOD — e.g., smart lock / lockbox / key fob].
Check-in time: 4:00 PM | Check-out time: 11:00 AM

WiFi name and password are on the welcome card inside the unit and included in your check-in instructions.
```

### 5. Neighborhood Overview
Structure exactly as follows:

```
[2 sentences on what Downtown Atlanta / this location means for the guest experience]

Walkable to:
- [List 5–8 specific nearby destinations with approximate walk time]
  Examples: State Farm Arena (X min walk), Georgia World Congress Center, Georgia Aquarium,
  World of Coca-Cola, CNN Center, Centennial Olympic Park, Ponce City Market, BeltLine trailheads

The neighborhood is active 24/7 with events, restaurants, and nightlife. Building security
is staffed around the clock.
```

### 6. Getting Around
**This field is ONLY for transportation options. Never paste check-in instructions, parking lot details, or building access info here.**

Structure:

```
The location is extremely walkable — most Downtown Atlanta attractions are within a 10–15 minute walk.

Public Transit
- MARTA rail: [nearest station] (~X min walk) — direct service to Hartsfield-Jackson Airport
- Multiple bus routes on Peachtree Street

Rideshare
Uber and Lyft readily available. Designated pickup zone at building entrance.

Parking
Multiple paid parking garages within a 1–5 minute walk. Parking is not included with the reservation.
See "Other Things to Note" for full parking details.

[If unit has paid_parking_on_premises: true]
Paid parking is available on the premises. Rates and availability may vary.
```

### 7. Other Things to Note
This is where all policy, fee, and logistical detail lives. Structure:

```
CHECK-IN / CHECK-OUT
Check-in: 4:00 PM | Check-out: 11:00 AM
Early check-in from 1:00 PM: $45 fee (subject to availability)
Late check-out until 1:30 PM: $45 fee (subject to availability)

MINIMUM AGE
The primary guest must be 26 years of age or older. Exceptions may be considered — contact us before booking.

KEY FOB
A $[FEE] key fob replacement fee applies if the fob is not returned at checkout.

HOUSE RULES
- No smoking anywhere in the unit or on the balcony/patio
- No parties or events
- No unregistered guests
- Quiet hours: 10:00 PM – 8:00 AM (building policy)
- Maximum occupancy: [MAX from listing]

PARKING
[PASTE FULL PARKING DISCLAIMER BELOW — word for word]

Parking Information – Peachtree Towers

We understand that parking is an important part of planning your trip, and there are several convenient, secure, and affordable parking options located just steps from the building. Most guests find parking quick and easy once they arrive.

Closest & Most Convenient Option

AAA Parking Garage – 17 Baker St NE, Atlanta, GA 30308
- Approximately 1–2 minute walk from the building
- Covered garage, safe and secure
- Generally the most convenient option for guests
- Rates vary based on demand and city events
- Typically has reliable availability except during major downtown events

Additional Nearby Parking Options

Peachtree Center Garage – 161 Peachtree Center Ave
- Approximately 5-minute walk
- Covered and secure
- Typical rates range from $10–$15 per day (may vary)

LAZ Parking – Courtland Street Lots
- Approximately 4–6 minute walk
- Often offers additional availability during busy periods
- Typical rates range from $8–$15 per day (may vary)

Street Parking

Street parking may be available on Peachtree Street, Baker Street, and surrounding blocks.
- Typically $2–$4 per hour
- Limited availability, especially during business hours and events
- Please review posted signage carefully, as some areas have restricted or tow-away zones

Helpful Tip: ParkMobile App

We highly recommend downloading the ParkMobile app before arrival. It allows you to view nearby options, compare real-time pricing, check availability, and extend parking remotely from your phone.

Event & Convention Notice

Downtown Atlanta hosts many major events throughout the year. Parking rates may increase during high-demand periods, including events at Georgia World Congress Center, Mercedes-Benz Stadium, State Farm Arena, Dragon Con, and major conventions, concerts, and sporting events. Arriving earlier in the day can help secure the best rates and availability.

Street Parking Disclaimer
Available on surrounding blocks during select hours. Guests are responsible for locating availability and complying with all posted signage, restrictions, and tow-away zones. Any parking fees, tickets, or penalties are the sole responsibility of the guest.
```

### 8. Directions (Check-in Instructions)
**This is NOT where Getting Around content goes.** This field contains:

```
Self check-in details:
[Lockbox location / smart lock code delivery method]

Building entry:
- Enter through the main lobby at 300 Peachtree Road NE
- Present your ID to the front desk security guard
- Take the elevator to floor [FLOOR]
- Unit [UNIT_LABEL] is [left/right] from the elevator

Parking:
Do not include full parking guide here — link to "Other Things to Note" instead.
Brief note only: "Nearest parking: AAA Garage at 17 Baker St NE, ~1 min walk."
```

### 9. Photo Captions
- **Read each photo before writing the caption.** Match what is actually visible.
- Format: `[Room/area] — [one specific detail visible in the photo]`
- Examples:
  - `Living room — floor-to-ceiling windows with Midtown skyline views`
  - `Bedroom — king bed with city views, blackout curtains`
  - `Kitchen — full appliances including dishwasher and coffee maker`
  - `Private patio — outdoor seating with Downtown Atlanta views`
  - `Bathroom — walk-in shower with rainfall showerhead`
- Never use: "cozy", "beautiful", "stunning", "amazing", "gorgeous"
- Never copy a caption from another unit's photo

---

## LOCKED COPY BLOCKS

### HVAC (copy word-for-word into "The Space" under "Heating & Cooling")

```
To adjust the heating and cooling, follow these steps:

Seasonal adjustment: As mentioned in the listing, the heating/cooling functions change with the seasons. In spring and summer you can adjust the A/C, while in late fall and winter you can adjust the heating controls.

Accessing controls: Locate the radiation unit underneath the window in each room.

Panel access: On top of the radiation unit, find the square panel.

Activating controls: Press the back two corners of the square panel to display the fan adjustment controls.

By following these steps, you can access and adjust the heating and cooling according to your needs.
```

### Street Parking Disclaimer (always append wherever street parking is mentioned)

```
Available on surrounding blocks during select hours. Guests are responsible for locating availability and complying with all posted signage, restrictions, and tow-away zones. Any parking fees, tickets, or penalties are the sole responsibility of the guest.
```

---

## PLACEHOLDER REFERENCE

When filling a per-unit brief, replace these tokens:

| Placeholder       | What to fill in                                         |
|-------------------|---------------------------------------------------------|
| `[UNIT_LABEL]`    | e.g., `4-L`, `21-I`                                    |
| `[FLOOR]`         | Floor number from unit-profiles.json                   |
| `[BED_TYPE]`      | e.g., `King`, `Queen`, `Queen (BR1) + Double (BR2)`    |
| `[BATHROOM_TYPE]` | Exact string from unit-profiles.json                   |
| `[OUTDOOR]`       | `Private patio` or `Private balcony` + view description |
| `[HAS_WORKSPACE]` | `true` / `false`                                       |
| `[HAS_ETHERNET]`  | `true` / `false`                                       |
| `[HAS_TRASH_COMP]`| `true` / `false`                                       |
| `[HAS_CEIL_FAN]`  | `true` / `false`                                       |
| `[SQFT]`          | Square footage if known (only 21-I has this: 1150)     |
| `[FOB_FEE]`       | Key fob replacement fee in dollars                     |
| `[MAX_GUESTS]`    | Maximum guest count from Airbnb listing settings       |
