import type { ApiProduct } from "./api";

export interface ApiSeller {
  id: number;
  full_name: string;
  avatar_url: string | null;
  shop_name: string | null;
  shop_address: string | null;
  phone: string | null;
  created_at: string;
  specialty: string | null;
  story: string | null;
  location: string | null;
  years_of_experience: number | null;
  is_featured: boolean;
  product_count: number;
  rating: number | null;
  review_count: number;
}

export interface SellerListResponse {
  sellers: ApiSeller[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

async function apiFetchNode<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { "Content-Type": "application/json" } });
  const text = await res.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error("Invalid JSON from API"); }
  if (!res.ok) {
    const err = (data as { error?: string }).error;
    throw new Error(err || "Request failed");
  }
  return data as T;
}

export async function fetchTopSellers(): Promise<{ sellers: ApiSeller[] }> {
  return apiFetchNode("/sellers/featured");
}

export async function fetchSellers(params?: {
  search?: string;
  specialty?: string;
  sort?: "rating" | "reviews" | "newest";
  page?: number;
  limit?: number;
}): Promise<SellerListResponse> {
  const sp = new URLSearchParams();
  if (params?.search) sp.set("search", params.search);
  if (params?.specialty) sp.set("specialty", params.specialty);
  if (params?.sort) sp.set("sort", params.sort);
  if (params?.page) sp.set("page", String(params.page));
  if (params?.limit) sp.set("limit", String(params.limit));
  const qs = sp.toString();
  return apiFetchNode(`/sellers${qs ? `?${qs}` : ""}`);
}

export async function fetchSeller(id: string | number): Promise<{ seller: ApiSeller; products: ApiProduct[] }> {
  return apiFetchNode(`/sellers/${id}`);
}
