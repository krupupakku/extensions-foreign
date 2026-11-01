import {
    BadgeColor,
    Chapter,
    ChapterDetails,
    ChapterProviding,
    ContentRating,
    HomePageSectionsProviding,
    HomeSection,
    HomeSectionType,
    MangaProviding,
    PagedResults,
    PartialSourceManga,
    SearchRequest,
    SearchResultsProviding,
    SourceInfo,
    SourceIntents,
    SourceManga,
    Tag,
    TagSection,
} from '@paperback/types'

const MD_DOMAIN = 'https://mangadex.org'
const MD_API = 'https://api.mangadex.org'
const MD_COVERS = 'https://uploads.mangadex.org/covers'

// Languages for which chapters are fetched (MangaDex language codes)
const LANGUAGES = ['it', 'en']
const PAGE_SIZE = 30
const CHAPTER_PAGE_SIZE = 500
const RATINGS = ['safe', 'suggestive', 'erotica']

export const MangaDexInfo: SourceInfo = {
    version: '1.0.0',
    name: 'MangaDex',
    description: 'Extension that pulls manga from MangaDex (uses the official API).',
    author: 'NmN',
    authorWebsite: 'http://github.com/pandeynmm',
    icon: 'icon.png',
    contentRating: ContentRating.MATURE,
    language: 'multi',
    websiteBaseURL: MD_DOMAIN,
    sourceTags: [
        {
            text: 'MULTI',
            type: BadgeColor.GREY,
        },
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS,
}

export class MangaDex implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding {
    // No HTML parsing needed: MangaDex exposes a JSON API
    constructor(_cheerio?: unknown) {}

    RETRIES = 3
    requestManager = App.createRequestManager({
        requestsPerSecond: 4,
        requestTimeout: 20000,
    })

    private async api(path: string): Promise<any> {
        const request = App.createRequest({
            url: `${MD_API}${path}`,
            method: 'GET',
        })
        const response = await this.requestManager.schedule(request, this.RETRIES)
        if (response.status > 399) throw new Error(`MangaDex API error ${response.status} on ${path}`)
        return typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    }

    private ratingQuery(): string {
        return RATINGS.map((r) => `contentRating[]=${r}`).join('&')
    }

    private langQuery(): string {
        return LANGUAGES.map((l) => `translatedLanguage[]=${l}`).join('&')
    }

    // ---------- Parsing helpers ----------

    private pickTitle(titles: any, altTitles: any[] = []): string {
        if (!titles) return 'Unknown'
        const preferred = altTitles.find((t) => t.it)?.it
        return titles.en ?? preferred ?? Object.values<string>(titles)[0] ?? 'Unknown'
    }

    private coverUrl(manga: any): string {
        const cover = (manga.relationships ?? []).find((r: any) => r.type === 'cover_art')
        const file = cover?.attributes?.fileName
        return file ? `${MD_COVERS}/${manga.id}/${file}.256.jpg` : ''
    }

    private toPartial(manga: any): PartialSourceManga {
        return App.createPartialSourceManga({
            mangaId: manga.id,
            image: this.coverUrl(manga),
            title: this.pickTitle(manga.attributes.title, manga.attributes.altTitles),
            subtitle: undefined,
        })
    }

    // ---------- MangaProviding ----------

    getMangaShareUrl(mangaId: string): string {
        return `${MD_DOMAIN}/title/${mangaId}`
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const json = await this.api(`/manga/${mangaId}?includes[]=cover_art&includes[]=author&includes[]=artist`)
        const manga = json.data
        const attr = manga.attributes

        const names = (type: string): string =>
            (manga.relationships ?? [])
                .filter((r: any) => r.type === type)
                .map((r: any) => r.attributes?.name)
                .filter(Boolean)
                .join(', ')

        const tags: Tag[] = (attr.tags ?? []).map((t: any) =>
            App.createTag({ id: t.id, label: t.attributes?.name?.en ?? 'Unknown' })
        )

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [this.pickTitle(attr.title, attr.altTitles), ...(attr.altTitles ?? []).flatMap((t: any) => Object.values(t) as string[])],
                image: this.coverUrl(manga).replace('.256.jpg', ''),
                status: this.capitalize(attr.status ?? 'unknown'),
                author: names('author'),
                artist: names('artist'),
                tags: [App.createTagSection({ id: 'genres', label: 'Genres', tags })],
                desc: attr.description?.it ?? attr.description?.en ?? '',
                hentai: attr.contentRating === 'pornographic',
            }),
        })
    }

    private capitalize(s: string): string {
        return s.charAt(0).toUpperCase() + s.slice(1)
    }

    // ---------- ChapterProviding ----------

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const chapters: Chapter[] = []
        let offset = 0
        let total = 1
        let index = 0

        while (offset < total) {
            const json = await this.api(
                `/manga/${mangaId}/feed?limit=${CHAPTER_PAGE_SIZE}&offset=${offset}&${this.langQuery()}&${this.ratingQuery()}&contentRating[]=pornographic&order[volume]=desc&order[chapter]=desc&includes[]=scanlation_group`
            )
            total = json.total ?? 0
            offset += CHAPTER_PAGE_SIZE

            for (const c of json.data ?? []) {
                const a = c.attributes
                // Skip chapters hosted externally: not readable inside the app
                if (a.externalUrl) continue
                const group = (c.relationships ?? []).find((r: any) => r.type === 'scanlation_group')?.attributes?.name
                const chapNum = Number(a.chapter)
                chapters.push(
                    App.createChapter({
                        id: c.id,
                        name: a.title ?? '',
                        chapNum: isNaN(chapNum) ? 0 : chapNum,
                        volume: a.volume ? Number(a.volume) : undefined,
                        langCode: a.translatedLanguage ?? 'en',
                        group: group,
                        time: new Date(a.publishAt ?? a.createdAt),
                        sortingIndex: index++,
                    })
                )
            }
        }
        return chapters
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const json = await this.api(`/at-home/server/${chapterId}`)
        const base = json.baseUrl
        const hash = json.chapter.hash
        const pages: string[] = (json.chapter.data as string[]).map((f) => `${base}/data/${hash}/${f}`)

        return App.createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages,
        })
    }

    // ---------- Search ----------

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const offset: number = metadata?.offset ?? 0
        if (offset === -1) return App.createPagedResults({ results: [], metadata: { offset: -1 } })

        let url = `/manga?limit=${PAGE_SIZE}&offset=${offset}&includes[]=cover_art&${this.ratingQuery()}&contentRating[]=pornographic`
        if (query.title) url += `&title=${encodeURIComponent(query.title)}`
        for (const tag of query.includedTags ?? []) url += `&includedTags[]=${tag.id}`
        if (!query.title) url += '&order[followedCount]=desc'

        const json = await this.api(url)
        const results = (json.data ?? []).map((m: any) => this.toPartial(m))
        const next = offset + PAGE_SIZE
        return App.createPagedResults({
            results,
            metadata: { offset: next >= (json.total ?? 0) ? -1 : next },
        })
    }

    async getSearchTags(): Promise<TagSection[]> {
        const json = await this.api('/manga/tag')
        const tags: Tag[] = (json.data ?? []).map((t: any) =>
            App.createTag({ id: t.id, label: t.attributes?.name?.en ?? 'Unknown' })
        )
        return [App.createTagSection({ id: 'genres', label: 'Genres', tags })]
    }

    // ---------- Home page ----------

    private sections(): { id: string; title: string; query: string }[] {
        return [
            { id: 'popular', title: 'Popular', query: 'order[followedCount]=desc' },
            { id: 'latest', title: 'Latest Updates', query: `order[latestUploadedChapter]=desc&${this.langQuery()}` },
            { id: 'new', title: 'Recently Added', query: 'order[createdAt]=desc' },
        ]
    }

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const defs = this.sections()
        const promises: Promise<void>[] = []

        for (const def of defs) {
            const section = App.createHomeSection({
                id: def.id,
                title: def.title,
                containsMoreItems: true,
                type: HomeSectionType.singleRowNormal,
            })
            sectionCallback(section)
            promises.push(
                this.api(`/manga?limit=${PAGE_SIZE}&includes[]=cover_art&${this.ratingQuery()}&${def.query}`).then((json) => {
                    section.items = (json.data ?? []).map((m: any) => this.toPartial(m))
                    sectionCallback(section)
                })
            )
        }
        await Promise.all(promises)
    }

    async getViewMoreItems(homepageSectionId: string, metadata: any): Promise<PagedResults> {
        const offset: number = metadata?.offset ?? 0
        if (offset === -1) return App.createPagedResults({ results: [], metadata: { offset: -1 } })

        const def = this.sections().find((s) => s.id === homepageSectionId)
        if (!def) return App.createPagedResults({ results: [], metadata: { offset: -1 } })

        const json = await this.api(
            `/manga?limit=${PAGE_SIZE}&offset=${offset}&includes[]=cover_art&${this.ratingQuery()}&${def.query}`
        )
        const next = offset + PAGE_SIZE
        return App.createPagedResults({
            results: (json.data ?? []).map((m: any) => this.toPartial(m)),
            metadata: { offset: next >= (json.total ?? 0) ? -1 : next },
        })
    }
}

