import { getErrorMessage } from "@/lib/errors";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  loginUser,
  registerUser,
  fetchSecurityQuestions,
  fetchPasswordResetQuestions,
  verifySecurityAnswers,
  resetForgottenPassword,
} from "@/lib/api";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { Store, ShoppingBag, ArrowLeft, Phone, MapPin, Wallet, Home } from "lucide-react";

type SecQuestion = { id: number; question_text?: string; question?: string };

const Auth = () => {
  const navigate = useNavigate();
  const { refresh: refreshAuth } = useAuth();
  const [isLoading, setIsLoading] = useState(false);

  // Login
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  // Forgot / recovery
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotStep, setForgotStep] = useState<"email" | "questions" | "reset">("email");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotQuestions, setForgotQuestions] = useState<SecQuestion[]>([]);
  const [forgotAnswers, setForgotAnswers] = useState<Record<number, string>>({});
  const [resetToken, setResetToken] = useState("");
  const [forgotNewPassword, setForgotNewPassword] = useState("");
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState("");

  // Register
  const [regName, setRegName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirmPassword, setRegConfirmPassword] = useState("");
  const [regRole, setRegRole] = useState("buyer");

  const [regPhone, setRegPhone] = useState("");
  const [regAddress, setRegAddress] = useState("");
  const [regShopName, setRegShopName] = useState("");
  const [regShopAddress, setRegShopAddress] = useState("");
  const [regGcash, setRegGcash] = useState("");

  // Security questions list + selected
  const [securityQuestionOptions, setSecurityQuestionOptions] = useState<SecQuestion[]>([]);
  const [regSec, setRegSec] = useState([
    { qid: "", answer: "" },
    { qid: "", answer: "" },
    { qid: "", answer: "" },
  ]);

  const isVendor = regRole === "seller";

  useEffect(() => {
    let active = true;
    fetchSecurityQuestions()
      .then((data) => {
        if (active) setSecurityQuestionOptions(data.questions ?? []);
      })
      .catch(() => {
        if (active) setSecurityQuestionOptions([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleRegRoleChange = (role: string) => {
    setRegRole(role);
    if (role !== "seller") {
      setRegPhone("");
      setRegAddress("");
      setRegShopName("");
      setRegShopAddress("");
      setRegGcash("");
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const data = await loginUser(loginEmail, loginPassword);
      try {
        await refreshAuth();
      } catch {
        // ignore
      }
      toast.success(`Welcome back, ${data.user.full_name}!`);
      navigate(data.user.role === "admin" ? "/admin" : data.user.role === "seller" ? "/seller" : "/account");
    } catch (err) {
      toast.error(getErrorMessage(err, "Login failed"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotEmail) {
      toast.error("Enter your registered email");
      return;
    }
    setIsLoading(true);
    try {
      const data = await fetchPasswordResetQuestions(forgotEmail);
      setForgotQuestions(data.questions ?? []);
      setForgotAnswers({});
      setForgotStep("questions");
    } catch (err) {
      toast.error(getErrorMessage(err, "Unable to start password recovery"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const answers = forgotQuestions.map((q) => ({
      question_id: q.id,
      answer: forgotAnswers[q.id] ?? "",
    }));
    if (answers.some((a) => !a.answer.trim())) {
      toast.error("Answer all security questions");
      return;
    }
    setIsLoading(true);
    try {
      const data = await verifySecurityAnswers(forgotEmail, answers);
      setResetToken(data.reset_token);
      setForgotStep("reset");
    } catch (err) {
      toast.error(getErrorMessage(err, "Security answers are incorrect"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (forgotNewPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (forgotNewPassword !== forgotConfirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    setIsLoading(true);
    try {
      await resetForgottenPassword(resetToken, forgotNewPassword, forgotConfirmPassword);
      toast.success("Password updated. You can now sign in.");
      setForgotOpen(false);
      setForgotStep("email");
      setLoginEmail(forgotEmail);
      setLoginPassword("");
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to reset password"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (regPassword !== regConfirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    const secPayload = regSec.map((s) => ({
      question_id: Number(s.qid),
      answer: s.answer,
    }));
    if (regSec.some((s) => !s.qid || !s.answer.trim())) {
      toast.error("Select and answer three security questions");
      return;
    }
    const ids = secPayload.map((s) => s.question_id);
    if (new Set(ids).size !== 3) {
      toast.error("Security questions must be different");
      return;
    }

    setIsLoading(true);
    try {
      const data = await registerUser({
        full_name: regName,
        email: regEmail,
        password: regPassword,
        confirm_password: regConfirmPassword,
        role: regRole,
        ...(isVendor
          ? {
              phone: regPhone,
              address: regAddress,
              shop_name: regShopName,
              shop_address: regShopAddress,
              gcash_number: regGcash,
            }
          : {}),
        security_questions: secPayload,
      });
      try {
        await refreshAuth();
      } catch {
        // ignore
      }
      toast.success(`Account created! Welcome, ${data.user.full_name}!`);
      navigate(data.user.role === "admin" ? "/admin" : data.user.role === "seller" ? "/seller" : "/account");
    } catch (err) {
      toast.error(getErrorMessage(err, "Registration failed"));
    } finally {
      setIsLoading(false);
    }
  };

  const qText = (q: SecQuestion) => q.question_text ?? q.question ?? "";

  const selectedIds = regSec.map((s) => s.qid);

  if (forgotOpen) {
    return (
      <>
        <Helmet>
          <title>Forgot Password | LanaoCrafts</title>
        </Helmet>
        <div className="min-h-screen">
          <Navbar />
          <main className="container mx-auto flex min-h-[calc(100vh-200px)] items-center justify-center px-4 py-12">
            <div className="w-full max-w-md">
              <button
                onClick={() => { setForgotOpen(false); setForgotStep("email"); }}
                className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-primary"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Sign In
              </button>
              <Card className="p-6">
                <h1 className="font-display text-2xl font-bold mb-1 text-center">Forgot Password</h1>
                <p className="text-sm text-muted-foreground text-center mb-6">Recover your account using security questions.</p>

                {forgotStep === "email" && (
                  <form onSubmit={handleForgotEmailSubmit} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="forgot-email">Registered Email</Label>
                      <Input
                        id="forgot-email"
                        type="email"
                        value={forgotEmail}
                        onChange={(e) => setForgotEmail(e.target.value)}
                        required
                      />
                    </div>
                    <Button type="submit" variant="gold" className="w-full" disabled={isLoading}>
                      {isLoading ? "Loading..." : "Continue"}
                    </Button>
                  </form>
                )}

                {forgotStep === "questions" && (
                  <form onSubmit={handleForgotVerifySubmit} className="space-y-4">
                    {forgotQuestions.map((q) => (
                      <div key={q.id} className="space-y-2">
                        <Label>{qText(q)}</Label>
                        <Input
                          value={forgotAnswers[q.id] ?? ""}
                          onChange={(e) =>
                            setForgotAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                          }
                          required
                        />
                      </div>
                    ))}
                    <Button type="submit" variant="gold" className="w-full" disabled={isLoading}>
                      {isLoading ? "Verifying..." : "Verify Answers"}
                    </Button>
                  </form>
                )}

                {forgotStep === "reset" && (
                  <form onSubmit={handleForgotResetSubmit} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="new-password">New Password</Label>
                      <Input
                        id="new-password"
                        type="password"
                        value={forgotNewPassword}
                        onChange={(e) => setForgotNewPassword(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="confirm-new-password">Confirm Password</Label>
                      <Input
                        id="confirm-new-password"
                        type="password"
                        value={forgotConfirmPassword}
                        onChange={(e) => setForgotConfirmPassword(e.target.value)}
                        required
                      />
                    </div>
                    <Button type="submit" variant="gold" className="w-full" disabled={isLoading}>
                      {isLoading ? "Updating..." : "Update Password"}
                    </Button>
                  </form>
                )}
              </Card>
            </div>
          </main>
          <Footer />
        </div>
      </>
    );
  }

  return (
    <>
      <Helmet>
        <title>Sign In | LanaoCrafts</title>
        <meta name="description" content="Sign in or create an account on LanaoCrafts" />
      </Helmet>

      <div className="min-h-screen">
        <Navbar />
        <main className="container mx-auto flex min-h-[calc(100vh-200px)] items-center justify-center px-4 py-12">
          <div className="w-full max-w-md">
            <Link
              to="/"
              className="mb-6 inline-flex items-center text-sm text-muted-foreground hover:text-primary"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Home
            </Link>

            <Card className="p-6">
              <div className="mb-6 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-gold">
                  <span className="font-display text-xl font-bold text-primary-foreground">L</span>
                </div>
                <h1 className="font-display text-2xl font-bold">Welcome to LanaoCrafts</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Sign in to your account or create a new one
                </p>
              </div>

              <Tabs defaultValue="login" className="w-full">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="login">Sign In</TabsTrigger>
                  <TabsTrigger value="register">Register</TabsTrigger>
                </TabsList>

                <TabsContent value="login" className="mt-6">
                  <form onSubmit={handleLogin} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="login-email">Email</Label>
                      <Input
                        id="login-email"
                        type="email"
                        placeholder="you@example.com"
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="login-password">Password</Label>
                        <button
                          type="button"
                          className="text-xs text-primary hover:underline"
                          onClick={() => { setForgotOpen(true); setForgotEmail(loginEmail); setForgotStep("email"); }}
                        >
                          Forgot Password?
                        </button>
                      </div>
                      <Input
                        id="login-password"
                        type="password"
                        placeholder="••••••••"
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        required
                      />
                    </div>
                    <Button
                      type="submit"
                      variant="gold"
                      className="w-full"
                      disabled={isLoading}
                    >
                      {isLoading ? "Signing in..." : "Sign In"}
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="register" className="mt-6">
                  <form onSubmit={handleRegister} className="space-y-4">
                    {/* Account Type */}
                    <div className="space-y-2">
                      <Label>I want to</Label>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="cursor-pointer">
                          <input
                            type="radio"
                            name="accountType"
                            value="buyer"
                            className="peer sr-only"
                            checked={regRole === "buyer"}
                            onChange={() => handleRegRoleChange("buyer")}
                          />
                          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-border p-4 transition-colors peer-checked:border-primary peer-checked:bg-primary/5">
                            <ShoppingBag className="h-6 w-6 text-primary" />
                            <span className="text-sm font-medium">Buy Products</span>
                          </div>
                        </label>
                        <label className="cursor-pointer">
                          <input
                            type="radio"
                            name="accountType"
                            value="seller"
                            className="peer sr-only"
                            checked={regRole === "seller"}
                            onChange={() => handleRegRoleChange("seller")}
                          />
                          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-border p-4 transition-colors peer-checked:border-primary peer-checked:bg-primary/5">
                            <Store className="h-6 w-6 text-primary" />
                            <span className="text-sm font-medium">Sell Crafts</span>
                          </div>
                        </label>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="register-name">Full Name</Label>
                      <Input
                        id="register-name"
                        type="text"
                        placeholder="Juan dela Cruz"
                        value={regName}
                        onChange={(e) => setRegName(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="register-email">Email</Label>
                      <Input
                        id="register-email"
                        type="email"
                        placeholder="you@example.com"
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="register-password">Password</Label>
                      <Input
                        id="register-password"
                        type="password"
                        placeholder="••••••••"
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="register-confirm-password">Confirm Password</Label>
                      <Input
                        id="register-confirm-password"
                        type="password"
                        placeholder="••••••••"
                        value={regConfirmPassword}
                        onChange={(e) => setRegConfirmPassword(e.target.value)}
                        required
                      />
                    </div>

                    {/* Security questions */}
                    <div className="space-y-3">
                      <Label>Security Questions (for password recovery)</Label>
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="space-y-2 rounded-md border border-border p-3">
                          <Select
                            value={regSec[i].qid}
                            onValueChange={(v) => {
                              const copy = [...regSec];
                              copy[i] = { ...copy[i], qid: v };
                              setRegSec(copy);
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select a question" />
                            </SelectTrigger>
                            <SelectContent>
                              {securityQuestionOptions
                                .filter((q) => !selectedIds.includes(String(q.id)) || String(q.id) === regSec[i].qid)
                                .map((q) => (
                                  <SelectItem key={q.id} value={String(q.id)}>
                                    {qText(q)}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                          <Input
                            placeholder="Your answer"
                            value={regSec[i].answer}
                            onChange={(e) => {
                              const copy = [...regSec];
                              copy[i] = { ...copy[i], answer: e.target.value };
                              setRegSec(copy);
                            }}
                          />
                        </div>
                      ))}
                    </div>

                    {isVendor && (
                      <>
                        <Separator className="my-1" />
                        <p className="text-sm text-muted-foreground">
                          These details are required so customers can reach your shop and so payouts
                          can be sent to your GCash account.
                        </p>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor="register-phone" className="flex items-center gap-1.5">
                              <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                              Contact Number
                            </Label>
                            <Input
                              id="register-phone"
                              type="tel"
                              inputMode="numeric"
                              placeholder="09171234567"
                              value={regPhone}
                              onChange={(e) => setRegPhone(e.target.value)}
                              required
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="register-gcash" className="flex items-center gap-1.5">
                              <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
                              GCash Number
                            </Label>
                            <Input
                              id="register-gcash"
                              type="tel"
                              inputMode="numeric"
                              placeholder="09171234567"
                              value={regGcash}
                              onChange={(e) => setRegGcash(e.target.value)}
                              required
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="register-shop-name" className="flex items-center gap-1.5">
                            <Store className="h-3.5 w-3.5 text-muted-foreground" />
                            Shop Name
                          </Label>
                          <Input
                            id="register-shop-name"
                            type="text"
                            placeholder="e.g., Maranao Weaving Co."
                            value={regShopName}
                            onChange={(e) => setRegShopName(e.target.value)}
                            required
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="register-address" className="flex items-center gap-1.5">
                            <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                            Address
                          </Label>
                          <Input
                            id="register-address"
                            type="text"
                            placeholder="Poblacion, Marawi City, Lanao del Sur"
                            value={regAddress}
                            onChange={(e) => setRegAddress(e.target.value)}
                            required
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="register-shop-address" className="flex items-center gap-1.5">
                            <Home className="h-3.5 w-3.5 text-muted-foreground" />
                            Shop Address
                          </Label>
                          <Textarea
                            id="register-shop-address"
                            rows={2}
                            placeholder="Stall / shop unit, market section, Marawi City"
                            value={regShopAddress}
                            onChange={(e) => setRegShopAddress(e.target.value)}
                            required
                          />
                        </div>
                      </>
                    )}
                    <Button
                      type="submit"
                      variant="gold"
                      className="w-full"
                      disabled={isLoading}
                    >
                      {isLoading ? "Creating account..." : "Create Account"}
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>
            </Card>
          </div>
        </main>
        <Footer />
      </div>
    </>
  );
};

export default Auth;
