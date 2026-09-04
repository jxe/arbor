import type { ComponentProps, ReactNode } from "react"
import { Markdown, useUser, type MutationActionError } from "arbor/react"
import type { ResultOf } from "arbor/data"
import type { myLists } from "../scripts/queries"
import type { practiceSearch } from "./PracticeSearch"

type MyList = ResultOf<typeof myLists>[number]
type Person = MyList["owner"]
type ListSummary = Pick<MyList,
  "id" | "name" | "about" | "visibility" | "owner" |
  "practiceCount" | "reactionCount" | "reactionProfiles"
>
type SearchedPractice = ResultOf<typeof practiceSearch>[number]
type PracticeSummary = Omit<SearchedPractice, "authors"> & {
  authors?: SearchedPractice["authors"]
}

function buttonClasses(secondary = false, selected = false, className = "") {
  return [
    "inline-flex cursor-pointer items-center justify-center gap-1 rounded-md border px-3 py-2 disabled:cursor-default disabled:opacity-40",
    selected
      ? "border-blue-400 bg-blue-50 text-blue-700"
      : secondary
        ? "border-slate-300 bg-slate-100 text-slate-700"
        : "border-slate-900 bg-slate-900 text-white",
    className,
  ].filter(Boolean).join(" ")
}

export function Button({ secondary = false, selected = false, className = "", ...props }:
  ComponentProps<"button"> & { secondary?: boolean; selected?: boolean }) {
  return <button className={buttonClasses(secondary, selected, className)} {...props} />
}

export function ButtonLink({ href, children, secondary = false, className = "", ...props }:
  ComponentProps<"a"> & { href: string; secondary?: boolean }) {
  return <a className={buttonClasses(secondary, false, className)} href={href} {...props}>{children}</a>
}

export function TextInput({ className = "", ...props }: ComponentProps<"input">) {
  return <input className={`rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 ${className}`} {...props} />
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return <select className={`rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 ${className}`} {...props} />
}

export function TextArea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <textarea className={`rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 ${className}`} {...props} />
}

export function Panel({ className = "", ...props }: ComponentProps<"section">) {
  return <section className={`rounded-lg border border-slate-200 bg-slate-50 p-4 ${className}`} {...props} />
}

export function Avatar({ person }: { person: Person }) {
  return (
    <a className="inline-flex items-center gap-1.5 text-sm" href={`Profile?id=${encodeURIComponent(person.id)}`}>
      {person.portrait ? <img className="size-8 rounded-full object-cover" src={person.portrait} alt="" /> : (
        <span className="inline-flex size-8 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-900" aria-hidden="true">
          {person.name.split(/\s+/).map(part => part[0]).join("").slice(0, 2)}
        </span>
      )}
      <span>{person.name}</span>
    </a>
  )
}

export function Attribution({ people, intro }: { people: Person[]; intro?: string }) {
  if (people.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
      {intro ? <span>{intro}</span> : null}
      {people.map(person => <Avatar key={person.id} person={person} />)}
    </div>
  )
}

export function Shell({ title, subtitle, actions, children }:
  { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const user = useUser()
  return (
    <div className="min-h-screen bg-white font-sans text-slate-800">
      <header className="sticky top-0 z-10 flex min-h-10 items-center gap-3 bg-slate-200 px-4 py-1.5 shadow-md">
        <a className="font-bold hover:underline" href="Home">Meaning Supplies</a>
        <span className="hidden text-xs text-slate-500 sm:inline">a directory of social practices</span>
        <nav className="ml-auto flex items-center gap-3 text-sm">
          {user ? <>
            <a className="hover:underline" href="MyLists">My lists</a>
            <a className="hover:underline" href={`Profile?id=${encodeURIComponent(user.profile)}`}>Your profile</a>
          </> : <span className="text-slate-500">Browsing anonymously</span>}
        </nav>
      </header>
      <div className="relative mx-auto mb-4 mt-7 max-w-6xl px-4 pt-12 text-center sm:pt-4">
        <div className="absolute left-4 top-0 flex gap-2 sm:left-auto sm:right-4">{actions}</div>
        <div className="my-2 text-3xl font-bold" role="heading" aria-level={1}>{title}</div>
        {subtitle ? <div className="text-slate-500">{subtitle}</div> : null}
      </div>
      <main className="mx-auto mb-20 max-w-5xl px-4">{children}</main>
    </div>
  )
}

export function ListCard({ list }: { list: ListSummary }) {
  const user = useUser()
  const userReacted = Boolean(user && list.reactionProfiles.some(reaction => reaction.profile === user.profile))
  return (
    <article className="flex min-w-0 flex-col rounded-lg border border-slate-200 bg-slate-50 p-4 transition hover:border-slate-300 hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold">
          <a href={`List?id=${encodeURIComponent(list.id)}`}>{list.name}</a>
          {list.visibility === "private" ? <span className="text-sm font-normal text-slate-500" title="Private"> · private</span> : null}
        </h2>
        <span className="shrink-0 text-xs text-slate-500">{list.practiceCount} practices</span>
      </div>
      {list.about ? <div className="my-3 leading-relaxed text-slate-600"><Markdown source={list.about} /></div> : null}
      <div className="mt-auto flex items-end justify-between pt-2">
        <Avatar person={list.owner} />
        <span className={userReacted ? "text-blue-600" : ""}>👍 {list.reactionCount}</span>
      </div>
    </article>
  )
}

export function PracticeCard({ practice }: { practice: PracticeSummary }) {
  return (
    <article className="flex min-w-0 flex-col rounded-lg border border-slate-200 bg-slate-50 p-4 transition hover:border-slate-300 hover:shadow-md">
      <h2 className="text-lg font-semibold"><a href={`Practice?id=${encodeURIComponent(practice.id)}`}>{practice.name}</a></h2>
      {practice.authors ? <Attribution people={practice.authors} intro="by" /> : null}
      <div className="mt-3 leading-relaxed text-slate-600"><Markdown source={practice.about} /></div>
    </article>
  )
}

export function ListGrid({ lists }: { lists: ListSummary[] }) {
  return <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{lists.map(list => <ListCard key={list.id} list={list} />)}</div>
}

export function PracticeGrid({ practices }: { practices: PracticeSummary[] }) {
  return <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-3">{practices.map(practice => <PracticeCard key={practice.id} practice={practice} />)}</div>
}

export function MutationError({ error }: { error?: MutationActionError }) {
  if (!error) return null
  return <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700" role="alert">{error.message}</p>
}
