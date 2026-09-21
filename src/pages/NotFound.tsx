import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { Link } from "react-router";

export default function NotFound() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="flex min-h-screen flex-col bg-background text-foreground"
    >
      <div className="flex flex-1 flex-col items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.85, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 220, damping: 18, delay: 0.1 }}
        >
          <Logo size={40} withWordmark={false} />
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.18 }}
          className="mt-6 font-display text-6xl font-bold tracking-tight"
        >
          404
        </motion.h1>
        <p className="mt-2 text-lg text-muted-foreground">
          This frame didn’t develop.
        </p>
        <Button asChild className="mt-8">
          <Link to="/">Back to home</Link>
        </Button>
      </div>
    </motion.div>
  );
}
