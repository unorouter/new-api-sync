// Type declarations for Bun fullstack dev server assets.

declare module "*.css";
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.png" {
  const src: string;
  export default src;
}
