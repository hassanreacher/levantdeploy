# shadcn/ui cheat sheet (components already in components/ui)
```tsx
import { Button } from "@/components/ui/button";            // variant: default|secondary|outline|ghost|link|destructive; size: default|sm|lg|icon; asChild
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";               // variant: default|secondary|outline|destructive
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";         // onCheckedChange={(v) => …} (v: boolean | "indeterminate")
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";   // mobile nav
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";   // type="single" collapsible
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";   // react-hook-form + zodResolver
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";                               // <Toaster /> is already in app/layout.tsx
import { cn } from "@/lib/utils";
```
- Link styled as button: `<Button asChild><Link href="/menu">See menu</Link></Button>`.
- Interactive components (Dialog, Sheet, Tabs with state, DropdownMenu, Select, toast) are client components — use them inside a `"use client"` file
  (rendering them from a server page is fine as long as you pass no functions as props).
- Always check what exists with list_files components/ui before importing; never re-create these files.
