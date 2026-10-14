import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useState } from "react";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSellers } from "@/hooks/useSellers";
import { useStartConversation } from "@/hooks/useMessages";
import { getStoredUser, resolveApiImageUrl } from "@/lib/api";
import { getErrorMessage } from "@/lib/errors";
import { toast } from "sonner";
import { MapPin, Loader2, MessageCircle, Search, Star, Store, ArrowLeft, ArrowRight } from "lucide-react";

const SORTS = [
  { value: "rating", label: "Highest Rated" },
  { value: "reviews", label: "Most Reviewed" },
  { value: "newest", label: "Newest" },
];

const Sellers = () => {
  const [search, setSearch] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [sort, setSort] = useState<"rating" | "reviews" | "newest">("rating");
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch } = useSellers({
    search: search.trim() || undefined,
    specialty: specialty.trim() || undefined,
    sort,
    page,
    limit: 12,
  });


  const sellers = data?.sellers ?? [];
  const totalPages = data?.totalPages ?? 1;

  const startConv = useStartConversation();
  const nav = (path: string) => (window.location.href = path);

  function handleMessage(sellerId: number) {
    const me = getStoredUser();
    if (!me || me.role !== "buyer") {
      toast.error("Please login as a buyer to message artisans");
      return;
    }
    startConv.mutate(
      { sellerId, productId: null },
      {
        onSuccess: (d) => (window.location.href = `/account/messages?conversation=${d.conversation_id}`),
        onError: (e) => toast.error(getErrorMessage(e, "Failed to start chat")),
      }
    );
  }

  // distinct specialties for filter
  const specialtyOptions = Array.from(new Set(sellers.map((s) => s.specialty).filter(Boolean))) as string[];

  return (
    <>
      <Helmet>
        <title>Discover Our Artisans | LanaoCrafts</title>
      </Helmet>
      <div className="min-h-screen">
        <Navbar />
        <main className="container mx-auto px-4 py-8">
          <div className="mb-8">
            <Link to="/" className="inline-flex items-center text-sm text-muted-foreground hover:text-primary">
              <ArrowLeft className="mr-1 h-4 w-4" /> Back to Home
            </Link>
            <h1 className="mt-2 font-display text-3xl font-bold md:text-4xl">
              Discover Our <span className="text-primary">Artisans</span>
            </h1>
          </div>

          {/* Controls */}
          <div className="mb-8 grid gap-4 md:grid-cols-4">
            <div className="relative md:col-span-2">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by seller or store name"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="pl-9"
              />
            </div>
            <Select value={sort} onValueChange={(v) => { setSort(v as "rating" | "reviews" | "newest"); setPage(1); }}>
              <SelectTrigger><SelectValue placeholder="Sort" /></SelectTrigger>
              <SelectContent>
                {SORTS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={specialty || "all"} onValueChange={(v) => { setSpecialty(v === "all" ? "" : v); setPage(1); }}>
              <SelectTrigger><SelectValue placeholder="Specialization" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Specializations</SelectItem>
                {specialtyOptions.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {isLoading && (
            <div className="flex items-center justify-center py-16" role="status">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          )}

          {isError && (
            <div className="py-16 text-center">
              <p className="text-muted-foreground">Something went wrong while loading sellers.</p>
              <Button variant="outline" className="mt-4" onClick={() => void refetch()}>Retry</Button>
            </div>
          )}

          {!isLoading && !isError && sellers.length === 0 && (
            <p className="py-16 text-center text-muted-foreground">No artisans found.</p>
          )}

          {!isLoading && !isError && sellers.length > 0 && (
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {sellers.map((seller) => {
                const name = seller.shop_name || seller.full_name;
                const initial = (seller.full_name || "A").charAt(0).toUpperCase();
                return (
                  <Card key={seller.id} className="p-6">
                    <div className="mb-4 flex items-center gap-4">
                      <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-gradient-gold text-2xl font-bold text-primary-foreground">
                        {seller.avatar_url ? (
                          <img src={resolveApiImageUrl(seller.avatar_url)} alt={name} className="h-full w-full object-cover" />
                        ) : initial}
                      </div>
                      <div>
                        <h3 className="font-display text-lg font-semibold">{name}</h3>
                        <p className="text-sm text-primary">{seller.specialty ?? "Artisan"}</p>
                      </div>
                    </div>
                    <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-4 w-4" />
                      {seller.location ?? "Lanao del Sur"}
                    </div>
                    <div className="mb-4 text-sm">
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
                    <div className="flex gap-2">
                      <Button variant="teal" className="flex-1" onClick={() => (window.location.href = `/sellers/${seller.id}`)}>
                        <Store className="mr-2 h-4 w-4" /> Visit Shop
                      </Button>
                      <Button variant="outline" className="flex-1" onClick={() => handleMessage(seller.id)} disabled={startConv.isPending}>
                        <MessageCircle className="mr-2 h-4 w-4" /> Message Seller
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {!isLoading && !isError && totalPages > 1 && (
            <div className="mt-8 flex items-center justify-center gap-4">
              <Button variant="outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ArrowLeft className="mr-1 h-4 w-4" /> Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
              <Button variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                Next <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          )}
        </main>
        <Footer />
      </div>
    </>
  );
};

export default Sellers;
