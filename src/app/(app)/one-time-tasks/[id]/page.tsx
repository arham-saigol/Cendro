import {TaskDetail} from "@/components/app/task-pages"; export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params; return <TaskDetail kind="one" id={id}/>}
