"use client";
/**
 * The Assets screen's forms (add an asset, edit photos, edit the spec sheet), loaded when they open. They carry the
 * spec form model, its zod schema and the photo uploader, which the listing itself never needs, so they stay out of
 * the first page load of /car.
 */
import dynamic from "next/dynamic";

export const AddAsset = dynamic(() => import("./add-asset").then((m) => m.AddAsset), { ssr: false });
export const PhotoEditor = dynamic(() => import("./photo-editor").then((m) => m.PhotoEditor), { ssr: false });
export const SpecEditor = dynamic(() => import("./spec-editor").then((m) => m.SpecEditor), { ssr: false });
