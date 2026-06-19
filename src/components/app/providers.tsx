"use client";
import {ConvexReactClient} from "convex/react"; import {ConvexProviderWithClerk} from "convex/react-clerk"; import {useAuth} from "@clerk/nextjs"; import {useEffect} from "react"; import {useMutation} from "convex/react"; import {api} from "../../../convex/_generated/api";
const url=process.env.NEXT_PUBLIC_CONVEX_URL;
const convex=url?new ConvexReactClient(url):null;
function UserSync(){const {isSignedIn}=useAuth(); const sync=useMutation(api.users.syncCurrentUser); useEffect(()=>{if(isSignedIn) void sync({});},[isSignedIn,sync]); return null}
export function ConvexClientProvider({children}:{children:React.ReactNode}){ if(!convex) return <div className="p-6">Set NEXT_PUBLIC_CONVEX_URL in your environment.</div>; return <ConvexProviderWithClerk client={convex} useAuth={useAuth}><UserSync/>{children}</ConvexProviderWithClerk> }
