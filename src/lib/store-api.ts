import { apiFetch } from "@/lib/api";
import type { ApiProduct } from "@/lib/api";

export interface StoreReview {
  id: number;
  seller_id: number;
  user_id: number;
  product_id: number | null;
  rating: number;
  comment: string | null;
  created_at: string;
  updated_at: string;
  reviewer_name: string;
  reviewer_avatar: string | null;
  product_name: string | null;
}

export interface StoreData {
  seller: {
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
  };
  products: ApiProduct[];
  reviews?: StoreReview[];
  average_rating: number | null;
  review_count: number;
  distribution?: Record<string, number>;
}

export async function fetchStore(id: string | number): Promise<StoreData> {
  return apiFetch<StoreData>(`/stores/${id}`);
}

export async function fetchStoreProducts(id: string | number): Promise<{ products: ApiProduct[] }> {
  return apiFetch<{ products: ApiProduct[] }>(`/stores/${id}/products`);
}

export async function fetchStoreReviews(id: string | number): Promise<{ reviews: StoreReview[]; average_rating: number | null; review_count: number; distribution: Record<string, number> }> {
  return apiFetch(`/stores/${id}/reviews`);
}

export async function submitStoreReview(id: string | number, body: { rating: number; comment?: string; product_id?: number | null }) {
  return apiFetch<{ success: boolean }>(`/stores/${id}/reviews`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateStoreReview(reviewId: number, body: { rating?: number; comment?: string; product_id?: number | null }) {
  return apiFetch<{ success: boolean }>(`/store-reviews/${reviewId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteStoreReview(reviewId: number) {
  return apiFetch<{ success: boolean }>(`/store-reviews/${reviewId}`, { method: "DELETE" });
}

// Product reviews
export interface ProductReview {
  id: number;
  product_id: number;
  user_id: number;
  rating: number;
  comment: string | null;
  created_at: string;
  updated_at: string;
  reviewer_name: string;
  reviewer_avatar: string | null;
}

export async function fetchProductReviews(id: string | number) {
  return apiFetch<{ reviews: ProductReview[]; average_rating: number | null; review_count: number; distribution: Record<string, number> }>(`/products/${id}/reviews`);
}

export async function submitProductReview(id: string | number, body: { rating: number; comment?: string }) {
  return apiFetch<{ success: boolean }>(`/products/${id}/reviews`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
