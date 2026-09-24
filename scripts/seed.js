// Dev seed: the 11 Customer App categories + their items, a set of active
// dev restaurants around Newtown, Kolkata, and one dev rider.
//
// Safe to re-run: everything is find-or-create / update-in-place, and stock
// toggles (restaurant_items.is_available) are never reset on an existing row.
//
//   npm run seed
//   SEED_CENTER_LAT=22.5726 SEED_CENTER_LNG=88.4340 npm run seed   # re-centre on another area
//
// Restaurants are deliberately split into PAIRS so the club/lock UX can be
// exercised for real: two categories can only be clubbed into one order if a
// single restaurant serves both. The pairs below mirror the design's own club
// map (Bengali<->Chinese, Bengali<->Sweets, North<->Mughlai, Mughlai<->Biryani,
// South<->Chaat, South<->Tiffin, Thali<->Continental). Everything else (e.g.
// Bengali+North) has no shared kitchen, so it hits the Lock sheet.
require("dotenv").config();
const db = require("../src/config/db");
const { normalizeCategoryName } = require("../src/utils/categoryName");

const CENTER = {
  lat: Number(process.env.SEED_CENTER_LAT) || 22.58,
  lng: Number(process.env.SEED_CENTER_LNG) || 88.47,
};

const WIKI = "https://commons.wikimedia.org/wiki/Special:FilePath/";

// [name, blurb, prepMin, prepMax, image, items: [name, price, isVeg, description][]]
// Items are listed in the design's order: the first three become the "Popular" section
// (ties on rating are broken by id, i.e. this order).
const CATEGORIES = [
  ["Bengali", "Fish, rice & sweet endings", 35, 45, "Cooked_shorshe_illish.jpg", [
    ["Shorshe Ilish", 280, false, "Mustard fish curry"],
    ["Kosha Mangsho", 310, false, "Slow-cooked mutton, dark gravy"],
    ["Aloo Posto", 130, true, "Poppy seed paste"],
    ["Doi Katla", 215, false, "Yoghurt gravy"],
    ["Basanti Pulao", 120, true, "Sweet yellow pulao, ghee"],
    ["Mishti Doi", 70, true, "Clay-pot sweet yoghurt"],
  ]],
  ["South Indian", "Dosa, idli, filter coffee", 30, 40, "Masala_Dosa_(Bengaluru).JPG", [
    ["Masala Dosa", 90, true, "Crisp rice crepe, potato filling"],
    ["Idli Sambar", 70, true, "Steamed rice cakes, lentil stew"],
    ["Uttapam", 90, true, "Thick savoury pancake"],
    ["Rava Dosa", 100, true, "Crisp semolina crepe"],
    ["Medu Vada", 60, true, "Fried lentil doughnut"],
    ["Filter Coffee", 45, true, "South Indian filter coffee"],
  ]],
  ["North Indian", "Dal, tandoor, rich gravies", 35, 45, "Paneer_Butter_Masala.jpg", [
    ["Rajma Chawal", 150, true, "Kidney beans, steamed rice"],
    ["Chole Bhature", 140, true, "Spiced chickpeas, fried bread"],
    ["Dal Makhani", 195, true, "Black dal, cooked overnight"],
    ["Butter Naan", 45, true, "Tandoor, brushed with butter"],
    ["Paneer Butter Masala", 225, true, "Tomato, cashew, butter"],
  ]],
  ["Mughlai", "Slow-cooked, rich spice", 35, 45, "Galouti_Kebab.jpg", [
    ["Butter Chicken", 260, false, "Tomato, cream, char"],
    ["Mutton Rogan Josh", 340, false, "Kashmiri red gravy"],
    ["Galouti Kebab", 240, false, "Melt-in-mouth minced kebab"],
    ["Sheermal", 50, true, "Saffron sweet flatbread"],
  ]],
  ["Biryani", "Layered rice, slow dum", 30, 40, "Hyderabadi_Chicken_Biryani.jpg", [
    ["Chicken Biryani", 260, false, "Dum-cooked, layered rice"],
    ["Mutton Biryani", 320, false, "Slow-cooked mutton, rice"],
    ["Veg Biryani", 180, true, "Mixed vegetable, rice"],
    ["Raita", 40, true, "Cooling yoghurt side"],
  ]],
  ["Chinese (Indo)", "Indo-Chinese wok classics", 25, 35, "Veg_Hakka_Noodles.jpg", [
    ["Hakka Noodles", 160, true, "Wok-tossed noodles"],
    ["Chilli Chicken", 220, false, "Dry-tossed, spiced"],
    ["Chilli Paneer", 195, true, "Veg, tossed on high flame"],
    ["Veg Manchurian", 150, true, "Fried veg balls, gravy"],
    ["Chicken Fried Rice", 190, false, "Wok-fried rice"],
  ]],
  ["Tiffin / Breakfast", "Light breakfast plates", 15, 25, "Kanda_poha.jpg", [
    ["Kanda Poha", 60, true, "Flattened rice, onion, peanuts"],
    ["Upma", 55, true, "Savoury semolina porridge"],
    ["Sabudana Khichdi", 65, true, "Tapioca pearls, peanuts"],
    ["Masala Omelette", 70, false, "Spiced onion omelette"],
  ]],
  ["Chaat & Snacks", "Street-side tang & crunch", 15, 20, "Papdi_chaat.jpg", [
    ["Pani Puri", 70, true, "Tangy water, crisp shells"],
    ["Sev Puri", 80, true, "Crisp discs, chutneys"],
    ["Bhel Puri", 70, true, "Puffed rice, tangy mix"],
    ["Aloo Tikki", 60, true, "Spiced potato patty"],
  ]],
  ["Sweets", "Bengali sweet-shop favourites", 15, 20, "Rosogolla.jpg", [
    ["Rosogolla", 80, true, "Spongy cottage-cheese balls"],
    ["Gulab Jamun", 70, true, "Fried milk-solid, syrup"],
    ["Rasmalai", 90, true, "Cottage cheese, saffron milk"],
    ["Kaju Katli", 150, true, "Cashew fudge diamonds"],
  ]],
  ["Continental", "Grills, pastas & salads", 30, 40, "Penne_all'arrabbiata.jpg", [
    ["Grilled Chicken", 280, false, "Herb-marinated, char-grilled"],
    ["Pasta Arrabbiata", 220, true, "Spicy tomato, garlic"],
    ["Caesar Salad", 190, true, "Romaine, parmesan, croutons"],
    ["Garlic Bread", 90, true, "Toasted, herb butter"],
  ]],
  ["Thali / Combos", "Complete home-style meals", 25, 35, "Veg_Thali.jpg", [
    ["Veg Thali", 150, true, "Dal, sabzi, rice, roti"],
    ["Non-Veg Thali", 220, false, "Curry, rice, roti"],
    ["Mini Thali", 110, true, "Smaller portions, same variety"],
  ]],
];

// dLat/dLng are degree offsets from CENTER (0.01 deg ~ 1.1 km), keeping every
// kitchen within ~2.5 km of the centre and well inside the 7 km catalog range.
// Restaurant login (OTP, purpose restaurant_login) works with these phones.
const RESTAURANTS = [
  { name: "Dev Kitchen 1 (Bengali + Chinese)", phone: "9000000101", dLat: -0.001, dLng: -0.005, cats: ["Bengali", "Chinese (Indo)"] },
  { name: "Dev Kitchen 2 (Bengali + Sweets)", phone: "9000000102", dLat: 0.005, dLng: 0.002, cats: ["Bengali", "Sweets"] },
  { name: "Dev Kitchen 3 (North Indian + Mughlai)", phone: "9000000103", dLat: -0.010, dLng: -0.010, cats: ["North Indian", "Mughlai"] },
  { name: "Dev Kitchen 4 (Mughlai + Biryani)", phone: "9000000104", dLat: -0.005, dLng: 0.010, cats: ["Mughlai", "Biryani"] },
  { name: "Dev Kitchen 5 (South Indian + Chaat)", phone: "9000000105", dLat: 0.010, dLng: -0.005, cats: ["South Indian", "Chaat & Snacks"] },
  { name: "Dev Kitchen 6 (South Indian + Tiffin)", phone: "9000000106", dLat: -0.012, dLng: 0.002, cats: ["South Indian", "Tiffin / Breakfast"] },
  { name: "Dev Kitchen 7 (Thali + Continental)", phone: "9000000107", dLat: 0.002, dLng: -0.014, cats: ["Thali / Combos", "Continental"] },
];

const DEV_RIDER = { name: "Dev Rider", phone: "9000000201", vehicle_type: "bike", vehicle_number: "WB 00 DEV 0001" };

async function main() {
  const categoryIdByName = {};
  const itemIdsByCategory = {};
  let itemsCreated = 0;

  for (const [name, blurb, prepMin, prepMax, img, items] of CATEGORIES) {
    const fields = {
      name_normalized: normalizeCategoryName(name),
      description: blurb,
      image_url: WIKI + img,
      prep_time_min_minutes: prepMin,
      prep_time_max_minutes: prepMax,
      is_active: true,
    };
    const existing = await db("categories").where({ name }).first();
    let categoryId;
    if (existing) {
      categoryId = existing.id;
      await db("categories").where({ id: categoryId }).update(fields);
    } else {
      [categoryId] = await db("categories").insert({ name, ...fields });
    }
    categoryIdByName[name] = categoryId;
    itemIdsByCategory[name] = [];

    // Insert in design order so ids ascend in the order the app shows them.
    for (const [itemName, price, isVeg, description] of items) {
      const itemFields = { description, price, is_veg: isVeg, is_active: true };
      const existingItem = await db("items").where({ category_id: categoryId, name: itemName }).first();
      let itemId;
      if (existingItem) {
        itemId = existingItem.id;
        await db("items").where({ id: itemId }).update(itemFields);
      } else {
        [itemId] = await db("items").insert({ category_id: categoryId, name: itemName, created_by_type: "admin", ...itemFields });
        itemsCreated++;
      }
      itemIdsByCategory[name].push(itemId);
    }
  }

  const clubPairs = new Set();
  for (const r of RESTAURANTS) {
    const fields = {
      name: r.name,
      address: "Dev seed address, Newtown, Kolkata",
      lat: Number((CENTER.lat + r.dLat).toFixed(7)),
      lng: Number((CENTER.lng + r.dLng).toFixed(7)),
      radius_km: 5,
      commission_rate_percent: 15,
      status: "active",
    };
    const existing = await db("restaurants").where({ phone: r.phone }).first();
    let restaurantId;
    if (existing) {
      restaurantId = existing.id;
      await db("restaurants").where({ id: restaurantId }).update(fields);
    } else {
      [restaurantId] = await db("restaurants").insert({ phone: r.phone, ...fields });
    }

    for (const catName of r.cats) {
      const categoryId = categoryIdByName[catName];
      const link = await db("restaurant_categories").where({ restaurant_id: restaurantId, category_id: categoryId }).first();
      if (!link) await db("restaurant_categories").insert({ restaurant_id: restaurantId, category_id: categoryId });

      // Stock every item in the category; never reset a toggle that already exists.
      for (const itemId of itemIdsByCategory[catName]) {
        const stock = await db("restaurant_items").where({ restaurant_id: restaurantId, item_id: itemId }).first();
        if (!stock) await db("restaurant_items").insert({ restaurant_id: restaurantId, item_id: itemId, is_available: true });
      }
    }
    if (r.cats.length === 2) clubPairs.add(r.cats.slice().sort().join("  <->  "));
  }

  const riderFields = {
    name: DEV_RIDER.name,
    vehicle_type: DEV_RIDER.vehicle_type,
    vehicle_number: DEV_RIDER.vehicle_number,
    status: "active",
    last_known_lat: Number((CENTER.lat + 0.001).toFixed(7)),
    last_known_lng: Number((CENTER.lng + 0.001).toFixed(7)),
  };
  const existingRider = await db("riders").where({ phone: DEV_RIDER.phone }).first();
  if (existingRider) await db("riders").where({ id: existingRider.id }).update(riderFields);
  else await db("riders").insert({ phone: DEV_RIDER.phone, ...riderFields });

  console.log(`Seeded around (${CENTER.lat}, ${CENTER.lng}):`);
  console.log(`  ${CATEGORIES.length} categories, ${itemsCreated} new items (${Object.values(itemIdsByCategory).flat().length} total)`);
  console.log(`  ${RESTAURANTS.length} active dev restaurants (login phones ${RESTAURANTS[0].phone}..${RESTAURANTS[RESTAURANTS.length - 1].phone}), 1 dev rider (${DEV_RIDER.phone})`);
  console.log("  Clubbable category pairs (share a kitchen):");
  for (const pair of clubPairs) console.log(`    ${pair}`);
  console.log("  Any other combination (e.g. Bengali + North Indian) has no shared kitchen -> Lock.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
