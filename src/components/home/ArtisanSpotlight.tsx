import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTopSellers } from "@/hooks/useSellers";
import { useStartConversation } from "@/hooks/useMessages";
import { getStoredUser, resolveApiImageUrl } from "@/lib/api";
import { getErrorMessage } from "@/lib/errors";
import { toast } from "sonner";
import { ErrorState } from "@/components/ErrorState";
import { ArrowRight, Loader2, MapPin, MessageCircle, Star, Store } from "lucide-react";

export function ArtisanSpotlight() {
  const { data: sellers = [], isLoading, isError, refetch } = useTopSellers();
  const navigate = useNavigate();
  const startConv = useStartConversation();

  function handleVisitShop(id: number) {
    navigate(`/sellers/${id}`);
  }

  function handleMessage(sellerId: number) {
    const me = getStoredUser();
    if (!me || me.role !== "buyer") {
      toast.error("Please login as a buyer to message sellers");
      return;
    }
    startConv.mutate(
      { sellerId, productId: null },
      {
        onSuccess: (data) => navigate(`/account/messages?conversation=${data.conversation_id}`),
        onError: (e) => toast.error(getErrorMessage(e, "Failed to start chat")),
      }
    );
  }

  return (
    <section className="py-16 lg:py-24" aria-labelledby="featured-shops-heading">
      <div className="container mx-auto px-4">
        <div className="mb-12 flex flex-col items-start justify-between gap-4 md:flex-row md:items-end">
          <div>
            <h2 id="featured-shops-heading" className="font-display text-3xl font-bold md:text-4xl">
              Featured <span className="text-primary">Seller Shops</span>
            </h2>
            <p className="mt-2 max-w-lg text-muted-foreground">
              Top-Rated Shops from our approved sellers, sorted by customer reviews
            </p>
          </div>
          <Button variant="outline" asChild>
            <Link to="/sellers">
              See All Sellers
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12" role="status" aria-label="Loading featured shops">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden="true" />
          </div>
        ) : isError ? (
          <ErrorState
            title="Couldn't load featured shops"
            description="Something went wrong while fetching the top-rated seller shops."
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {sellers
              .filter((seller) => seller.rating != null)
              .map((seller) => {
                const shopName = seller.shop_name || seller.full_name;
                const initial = (seller.full_name || "S").charAt(0).toUpperCase();
                return (
                  <Card key={seller.id} variant="artisan" className="p-6">
                    <div className="mb-4 flex items-center gap-4">
                      <button
                        type="button"
                        onClick={() => handleVisitShop(seller.id)}
                        className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-gradient-gold text-2xl font-bold text-primary-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                        aria-label={`Visit ${shopName}`}
                      >
                        {seller.avatar_url ? (
                          <img src={resolveApiImageUrl(seller.avatar_url)} alt={shopName} className="h-full w-full object-cover" />
                        ) : (
                          initial
                        )}
                      </button>
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => handleVisitShop(seller.id)}
                          className="block truncate text-left font-display text-lg font-semibold hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                        >
                          {shopName}
                        </button>
                        <p className="truncate text-sm text-muted-foreground">
                          {seller.full_name ? `Seller: ${seller.full_name}` : "Seller"}
                        </p>
                        {seller.specialty && <p className="text-sm text-primary">{seller.specialty}</p>}
                      </div>
                    </div>
                    <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{seller.location ?? seller.shop_address ?? "Lanao del Sur"}</span>
                    </div>
                    <div className="mb-2 text-sm">
                      {seller.rating != null ? (
                        <>
                          <Star className="inline h-4 w-4 fill-gold text-gold" aria-hidden="true" />
                          <span className="ml-1 font-medium">{seller.rating.toFixed(1)}</span>
                          <span className="ml-1 text-muted-foreground">
                            ({seller.review_count} {seller.review_count === 1 ? "review" : "reviews"})
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">No reviews yet</span>
                      )}
                    </div>
                    {seller.product_count ? (
                      <p className="mb-4 text-xs text-muted-foreground">
                        {seller.product_count} active {seller.product_count === 1 ? "product" : "products"}
                      </p>
                    ) : (
                      <p className="mb-4 text-xs text-muted-foreground">No active products yet</p>
                    )}
                    {seller.story && (
                      <p className="mb-4 text-sm text-muted-foreground line-clamp-2">{seller.story}</p>
                    )}
                    <div className="flex gap-2">
                      <Button
                        variant="teal"
                        className="flex-1"
                        onClick={() => handleVisitShop(seller.id)}
                      >
                        <Store className="mr-2 h-4 w-4" aria-hidden="true" />
                        Visit Shop
                      </Button>
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => handleMessage(seller.id)}
                        disabled={startConv.isPending}
                      >
                        <MessageCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                        Message Seller
                      </Button>
                    </div>
                  </Card>
                );
              })}
              {sellers.filter((seller) => seller.rating != null).length === 0 && (
                <p className="col-span-full py-12 text-center text-muted-foreground">
                  No featured sellers yet.
                </p>
              )}
            </div>

            <div className="mt-10 flex justify-center">
              <Button variant="outline" size="lg" asChild>
                <Link to="/sellers">
                  See More Sellers
                  <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
