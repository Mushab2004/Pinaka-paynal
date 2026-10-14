import { Helmet } from "react-helmet-async";
import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useStore, useStoreReviews, useSubmitStoreReview, useUpdateStoreReview, useDeleteStoreReview } from "@/hooks/useStores";
import { useStartConversation } from "@/hooks/useMessages";
import { getStoredUser } from "@/lib/api";
import { getErrorMessage } from "@/lib/errors";
import { toast } from "sonner";
import { MapPin, Loader2, MessageCircle, ArrowLeft, Star, Send, Trash2, Edit2 } from "lucide-react";
import { resolveApiImageUrl } from "@/lib/api";
import type { StoreReview } from "@/lib/store-api";

const SellerStore = () => {
  const { id } = useParams();
  const { data, isLoading, isError, refetch } = useStore(id);
  const { data: reviewsData } = useStoreReviews(id);
  const navigate = useNavigate();
  const startConv = useStartConversation();
  const submitReview = useSubmitStoreReview(id!);
  const updateReview = useUpdateStoreReview(id!);
  const deleteReview = useDeleteStoreReview(id!);

  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState("");
  const [editingReviewId, setEditingReviewId] = useState<number | null>(null);

  function handleMessage(sellerId: number) {
    const me = getStoredUser();
    if (!me || me.role !== "buyer") {
      toast.error("Please login as a buyer to message sellers");
      return;
    }
    startConv.mutate(
      { sellerId, productId: null },
      {
        onSuccess: (d) => navigate(`/account/messages?conversation=${d.conversation_id}`),
        onError: (e) => toast.error(getErrorMessage(e, "Failed to start chat")),
      }
    );
  }

  if (isLoading) {
    return (
      <>
        <Navbar />
        <main className="container mx-auto px-4 py-8 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </main>
      </>
    );
  }

  if (isError || !data) {
    return (
      <>
        <Navbar />
        <main className="container mx-auto px-4 py-8 text-center">
          <h1 className="text-2xl font-bold">Seller not found</h1>
          <p className="mt-2 text-muted-foreground">The store you are looking for does not exist.</p>
          <Button className="mt-4" asChild>
            <Link to="/sellers">Back to All Sellers</Link>
          </Button>
        </main>
        <Footer />
      </>
    );
  }

  const { seller, products } = data;
  const storeName = seller.shop_name || seller.full_name;

  const me = getStoredUser();
  const isBuyer = me?.role === "buyer";

  function handleSubmitReview(e: React.FormEvent) {
    e.preventDefault();
    if (!isBuyer) {
      toast.error("Please login as a buyer to submit a review");
      return;
    }
    if (editingReviewId) {
      updateReview.mutate(
        { reviewId: editingReviewId, body: { rating: reviewRating, comment: reviewComment } },
        {
          onSuccess: () => {
            setEditingReviewId(null);
            setReviewComment("");
            setReviewRating(5);
          },
        }
      );
    } else {
      submitReview.mutate(
        { rating: reviewRating, comment: reviewComment },
        {
          onSuccess: () => {
            setReviewComment("");
            setReviewRating(5);
          },
        }
      );
    }
  }

  function handleEditReview(r: StoreReview) {
    setEditingReviewId(r.id);
    setReviewRating(r.rating);
    setReviewComment(r.comment ?? "");
  }

  const reviews: StoreReview[] = reviewsData?.reviews ?? [];
  const initial = (seller.full_name || "A").charAt(0).toUpperCase();

  return (
    <>
      <Helmet>
        <title>{storeName} | LanaoCrafts</title>
      </Helmet>
      <div className="min-h-screen">
        <Navbar />
        <main className="container mx-auto px-4 py-8">
          <Link to="/sellers" className="inline-flex items-center text-sm text-muted-foreground hover:text-primary">
            <ArrowLeft className="mr-1 h-4 w-4" /> Back to All Sellers
          </Link>

          {/* Profile */}
          <Card className="mt-4 p-6">
            <div className="flex flex-col gap-6 md:flex-row md:items-start">
              <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-gold text-3xl font-bold text-primary-foreground">
                {seller.avatar_url ? (
                  <img src={seller.avatar_url} alt={storeName} className="h-full w-full object-cover" />
                ) : initial}
              </div>
              <div className="flex-1">
                <h1 className="font-display text-2xl font-bold">{storeName}</h1>
                {seller.shop_name && <p className="text-muted-foreground">{seller.full_name}</p>}
                <p className="text-primary">{seller.specialty ?? "Artisan"}</p>
                <div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1"><MapPin className="h-4 w-4" /> {seller.location ?? "Lanao del Sur"}</span>
                  {seller.story && <p className="mt-2 w-full text-muted-foreground">{seller.story}</p>}
                </div>
                <div className="mt-3 text-sm">
                  {seller.rating ? (
                    <>
                      <Star className="inline h-4 w-4 fill-yellow-400 text-yellow-400" />
                      <span className="ml-1 font-medium">{seller.rating.toFixed(1)}</span>
                      <span className="ml-1 text-muted-foreground">({seller.review_count} reviews)</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">No reviews yet</span>
                  )}
                </div>
                <div className="mt-4">
                  <Button variant="teal" onClick={() => handleMessage(seller.id)} disabled={startConv.isPending}>
                    <MessageCircle className="mr-2 h-4 w-4" /> Message Seller
                  </Button>
                </div>
              </div>
            </div>
          </Card>

          {/* Products */}
          <h2 className="mt-8 font-display text-xl font-bold">Products</h2>
          {products.length === 0 ? (
            <p className="mt-4 text-muted-foreground">This seller has not published any products yet.</p>
          ) : (
            <div className="mt-4 grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {products.map((p) => {
                const price = parseFloat(p.price);
                const inStock = Number(p.stock_quantity) > 0;
                return (
                  <Card key={p.id} className="overflow-hidden">
                    <img src={resolveApiImageUrl(p.image_url)} alt={p.name} className="aspect-square w-full object-cover" />
                    <div className="p-4">
                      <h3 className="font-semibold line-clamp-1">{p.name}</h3>
                      <p className="text-sm text-muted-foreground">{p.category_name}</p>
                      <p className="mt-1 font-semibold text-primary">₱{price.toLocaleString("en-PH", { minimumFractionDigits: 2 })}</p>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {inStock ? "In stock" : "Out of stock"}
                        {p.rating ? ` · ${Number(p.rating).toFixed(1)} ★` : ""}
                      </div>
                      <Button className="mt-3 w-full" variant="outline" asChild>
                        <Link to={`/products/${p.id}`}>View Product</Link>
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Reviews */}
          <Card className="mt-8 p-6">
            <h2 className="font-display text-xl font-bold mb-4">Store Reviews</h2>

            {/* Aggregate */}
            <div className="mb-6 flex flex-wrap items-center gap-4">
              <div className="text-3xl font-bold">
                {seller.rating ? seller.rating.toFixed(1) : "0.0"}
              </div>
              <div>
                <div className="flex">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <Star key={s} className={`h-5 w-5 ${s <= Math.round(seller.rating ?? 0) ? "fill-yellow-400 text-yellow-400" : "text-muted"}`} />
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">{seller.review_count} reviews</p>
              </div>
            </div>

            {/* Review form */}
            {isBuyer ? (
              <form onSubmit={handleSubmitReview} className="mb-6 space-y-3 border-t pt-4">
                <p className="text-sm font-medium">{editingReviewId ? "Edit your review" : "Write a review"}</p>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <button type="button" key={s} onClick={() => setReviewRating(s)}>
                      <Star className={`h-6 w-6 ${s <= reviewRating ? "fill-yellow-400 text-yellow-400" : "text-muted"}`} />
                    </button>
                  ))}
                </div>
                <textarea
                  className="w-full rounded-md border p-2 text-sm"
                  rows={3}
                  value={reviewComment}
                  onChange={(e) => setReviewComment(e.target.value)}
                  placeholder="Share your experience with this store..."
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={submitReview.isPending || updateReview.isPending}>
                    <Send className="mr-1 h-4 w-4" /> {editingReviewId ? "Update" : "Submit"}
                  </Button>
                  {editingReviewId && (
                    <Button type="button" size="sm" variant="outline" onClick={() => { setEditingReviewId(null); setReviewComment(""); setReviewRating(5); }}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            ) : (
              <p className="mb-6 text-sm text-muted-foreground border-t pt-4">
                Please log in as a buyer to submit a review.
              </p>
            )}

            {/* Reviews list */}
            <div className="space-y-4">
              {reviews.length === 0 ? (
                <p className="text-muted-foreground">No reviews yet.</p>
              ) : (
                reviews.map((r) => (
                  <div key={r.id} className="border-t pt-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-bold">
                          {r.reviewer_avatar ? (
                            <img src={resolveApiImageUrl(r.reviewer_avatar)} alt={r.reviewer_name} className="h-full w-full object-cover" />
                          ) : (
                            (r.reviewer_name || "U").charAt(0).toUpperCase()
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-medium">{r.reviewer_name}</p>
                          <p className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleDateString()}</p>
                        </div>
                      </div>
                      {me?.id === r.user_id && (
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => handleEditReview(r)}>
                            <Edit2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => deleteReview.mutate(r.id)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="mt-1 flex">
                      {[1, 2, 3, 4, 5].map((s) => (
                        <Star key={s} className={`h-4 w-4 ${s <= r.rating ? "fill-yellow-400 text-yellow-400" : "text-muted"}`} />
                      ))}
                    </div>
                    {r.product_name && (
                      <p className="mt-1 text-xs text-muted-foreground">Product: {r.product_name}</p>
                    )}
                    {r.comment && <p className="mt-2 text-sm">{r.comment}</p>}
                  </div>
                ))
              )}
            </div>
          </Card>
        </main>
        <Footer />
      </div>
    </>
  );
};

export default SellerStore;
