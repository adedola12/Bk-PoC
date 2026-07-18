/**
 * D1 master taxonomy — trade-based, per KB v1.1 §6.
 * Structure: trade → category → product type. Names are the classifier's
 * vocabulary anchors; keep them aligned with Nigerian QS trade conventions.
 * `keywords` feed the Stage 4 lexical matcher (Milestone C).
 */

export const TAXONOMY_TREE = [
  {
    name: "Civil & Structural",
    children: [
      { name: "Cement" },
      { name: "Aggregates" },
      { name: "Reinforcement" },
      { name: "Blocks" },
      { name: "Formwork" },
    ],
  },
  {
    name: "Masonry & Finishes",
    children: [
      { name: "Tiles" },
      { name: "Paints" },
      { name: "Screeds" },
      { name: "Cladding" },
    ],
  },
  {
    name: "Carpentry & Joinery",
    children: [
      { name: "Doors" },
      { name: "Boards" },
      { name: "Timber" },
      { name: "Ironmongery" },
    ],
  },
  { name: "Roofing", children: [] },
  {
    name: "Plumbing & Sanitary Ware",
    children: [
      {
        name: "Sanitary Ware",
        keywords: ["basin", "pedestal", "wc", "toilet seat", "cistern top"],
        children: [
          {
            name: "Wash Basins & Pedestals",
            children: [
              { name: "Countertop" },
              { name: "Pedestal" },
              { name: "Wall-Mounted" },
              { name: "Under-Mount" },
              { name: "Vessel" },
            ],
          },
          { name: "Toilets & Seats" },
        ],
      },
      { name: "Taps & Mixers", keywords: ["mixer", "tap", "faucet"] },
      {
        name: "Bathroom Accessories",
        keywords: ["towel rail", "toilet roll holder", "robe hook", "soap dish"],
      },
      {
        name: "Concealed Cisterns & Installation Systems",
        keywords: ["concealed cistern", "pre-wall", "installation frame", "dry build"],
      },
      { name: "Pipes & Fittings" },
      { name: "Drainage", keywords: ["drain", "trap", "waste"] },
    ],
  },
  { name: "Mechanical & HVAC", children: [] },
  {
    name: "Electrical",
    children: [
      { name: "Cables" },
      { name: "Switchgear" },
      { name: "Lighting" },
      { name: "Accessories" },
    ],
  },
  {
    name: "Tools & Equipment",
    children: [
      {
        name: "Power Tools",
        keywords: ["grinder", "drill", "rotary hammer", "saw", "sander"],
        children: [
          { name: "Grinding" },
          { name: "Grinding, Drilling & Demolition" },
          { name: "Impact & Diamond Drilling" },
          { name: "Cordless" },
          { name: "Measuring & Leveling" },
          { name: "Woodworking" },
        ],
      },
      { name: "Hand Tools" },
      { name: "Safety & PPE" },
    ],
  },
  { name: "Glazing & Aluminium", children: [] },
  { name: "External Works & Landscaping", children: [] },
];
