// Compiled by tsc: pin the generated request contract without sending requests.
import type { components, paths } from "../src/index.js";
const pod: components["schemas"]["CreatePodRequest"] = {
  name: "example", image: "example/image:tag", gpu: { id: "example-gpu" },
};
// Production permits template-based creation without an explicit image.
const fromTemplate: components["schemas"]["CreatePodRequest"] = { name: "example", templateId: "example-template", gpu: { id: "example-gpu" } };
// @ts-expect-error name is required independently of image.
const missingName: components["schemas"]["CreatePodRequest"] = { image: "example/image:tag" };
const billingPath: keyof paths = "/v2/billing/network-volumes";
// @ts-expect-error production removed this spelling.
const oldBillingPath: keyof paths = "/v2/billing/networkvolumes";
void [pod, fromTemplate, missingName, billingPath, oldBillingPath];

const template: components["schemas"]["CreateTemplateRequest"] = { name: "example", image: "example/image" };
// @ts-expect-error template creation always requires an image, including nested inheritance.
const templateWithoutImage: components["schemas"]["CreateTemplateRequest"] = { name: "example" };
const updateTemplate: components["schemas"]["UpdateTemplateRequest"] = {};
const updatePod: components["schemas"]["UpdatePodRequest"] = {};
type Assert<T extends true> = T;
type RequiredContainerFields = "image" | "args" | "disk" | "ports" | "env" | "registry";
type PodFieldsRequired = Assert<components["schemas"]["Pod"] extends Required<Pick<components["schemas"]["Pod"], RequiredContainerFields>> ? true : false>;
type TemplateFieldsRequired = Assert<components["schemas"]["Template"] extends Required<Pick<components["schemas"]["Template"], RequiredContainerFields>> ? true : false>;
void [template, templateWithoutImage, updateTemplate, updatePod];
