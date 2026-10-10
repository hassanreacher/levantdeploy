/**
 * builder-ui: "Add section" component library shown in the visual editor. The ids are builder-core's library
 * components (builder-template/library/index.json → visual-edit `insert` op copies <id>.tsx into
 * components/sections/ and imports it). Previews are wireframes (components/builder/section-preview.tsx).
 */

export type SectionCategory = "Layout" | "Marketing" | "Content" | "Forms";
export type SectionDef = { id: string; name: string; category: SectionCategory; description: string; backend?: boolean };

export const SECTION_LIBRARY: SectionDef[] = [
  { id: "navbar", name: "Navbar", category: "Layout", description: "Logo, links, call-to-action and mobile menu" },
  { id: "hero", name: "Hero", category: "Marketing", description: "Big headline, subtitle and two buttons" },
  { id: "features", name: "Features", category: "Marketing", description: "Feature cards with icons" },
  { id: "pricing", name: "Pricing", category: "Marketing", description: "Three plans with a highlighted one" },
  { id: "testimonials", name: "Testimonials", category: "Marketing", description: "Quotes from happy customers" },
  { id: "cta", name: "Call to action", category: "Marketing", description: "A bold banner with one button" },
  { id: "stats", name: "Stats", category: "Content", description: "Key numbers in a band" },
  { id: "faq", name: "FAQ", category: "Content", description: "Expandable questions and answers" },
  { id: "gallery", name: "Gallery", category: "Content", description: "Responsive image grid" },
  { id: "team", name: "Team", category: "Content", description: "Team members with photos and roles" },
  { id: "blog-list", name: "Blog list", category: "Content", description: "Latest articles as cards" },
  { id: "contact-form", name: "Contact form", category: "Forms", description: "Saves messages to your backend", backend: true },
  { id: "auth-forms", name: "Sign in / Sign up", category: "Forms", description: "Email + password auth with your backend", backend: true },
  { id: "footer", name: "Footer", category: "Layout", description: "Links, copyright and social" },
];

export const SECTION_CATEGORIES: SectionCategory[] = ["Layout", "Marketing", "Content", "Forms"];

export function sectionById(id: string): SectionDef | undefined {
  return SECTION_LIBRARY.find((s) => s.id === id);
}
