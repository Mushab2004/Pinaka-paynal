import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchStore, fetchStoreReviews, submitStoreReview, updateStoreReview, deleteStoreReview, fetchProductReviews, submitProductReview } from "@/lib/store-api";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errors";

export function useStore(id: string | undefined) {
  return useQuery({
    queryKey: ["store", id],
    queryFn: async () => {
      if (!id) throw new Error("No store ID");
      return fetchStore(id);
    },
    enabled: !!id,
  });
}

export function useStoreReviews(id: string | undefined) {
  return useQuery({
    queryKey: ["store-reviews", id],
    queryFn: async () => {
      if (!id) throw new Error("No store ID");
      return fetchStoreReviews(id);
    },
    enabled: !!id,
  });
}

export function useSubmitStoreReview(id: string | number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { rating: number; comment?: string; product_id?: number | null }) => submitStoreReview(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store", String(id)] });
      qc.invalidateQueries({ queryKey: ["store-reviews", String(id)] });
      qc.invalidateQueries({ queryKey: ["sellers"] });
      toast.success("Review submitted");
    },
    onError: (e) => toast.error(getErrorMessage(e, "Failed to submit review")),
  });
}

export function useUpdateStoreReview(storeId: string | number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ reviewId, body }: { reviewId: number; body: { rating?: number; comment?: string; product_id?: number | null } }) =>
      updateStoreReview(reviewId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store", String(storeId)] });
      qc.invalidateQueries({ queryKey: ["store-reviews", String(storeId)] });
      toast.success("Review updated");
    },
    onError: (e) => toast.error(getErrorMessage(e, "Failed to update review")),
  });
}

export function useDeleteStoreReview(storeId: string | number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reviewId: number) => deleteStoreReview(reviewId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["store", String(storeId)] });
      qc.invalidateQueries({ queryKey: ["store-reviews", String(storeId)] });
      toast.success("Review deleted");
    },
    onError: (e) => toast.error(getErrorMessage(e, "Failed to delete review")),
  });
}

export function useProductReviews(id: string | undefined) {
  return useQuery({
    queryKey: ["product-reviews", id],
    queryFn: async () => {
      if (!id) throw new Error("No product ID");
      return fetchProductReviews(id);
    },
    enabled: !!id,
  });
}

export function useSubmitProductReview(id: string | number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { rating: number; comment?: string }) => submitProductReview(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product", String(id)] });
      qc.invalidateQueries({ queryKey: ["product-reviews", String(id)] });
      toast.success("Review submitted");
    },
    onError: (e) => toast.error(getErrorMessage(e, "Failed to submit review")),
  });
}
