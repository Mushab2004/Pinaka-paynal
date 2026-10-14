import { useQuery } from "@tanstack/react-query";
import { fetchTopSellers, fetchSellers, fetchSeller } from "@/lib/seller-discovery-api";

export function useTopSellers() {
  return useQuery({
    queryKey: ["sellers", "featured"],
    queryFn: async () => {
      const data = await fetchTopSellers();
      return data.sellers;
    },
  });
}

export function useSellers(params?: { search?: string; specialty?: string; sort?: "rating" | "reviews" | "newest"; page?: number; limit?: number }) {
  return useQuery({
    queryKey: ["sellers", params],
    queryFn: () => fetchSellers(params),
  });
}

export function useSeller(id: string | undefined) {
  return useQuery({
    queryKey: ["seller", id],
    queryFn: async () => {
      if (!id) throw new Error("No seller ID");
      return fetchSeller(id);
    },
    enabled: !!id,
  });
}
