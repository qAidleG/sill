'use client'

import { useState, useRef, useEffect } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Settings, Home, Plus, Image as ImageIcon, MessageSquare, Trash2, Edit2, X } from 'lucide-react'
import Link from 'next/link'
import Image from 'next/image'
import { sendGrokMessage, generateImage } from '@/lib/api'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StarField } from '../components/StarField'
import { supabase } from '@/lib/supabase'
import { Roster } from '@/types/database'
import { useUser } from '@supabase/auth-helpers-react'
import { useRouter } from 'next/navigation'
import { Loader2, Send, User, Bot } from 'lucide-react'
import { toast } from 'react-hot-toast'

// Extend Character type to include display image
interface ChatCharacter extends Roster {
  displayImage: string
}

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  imageUrl?: string  // Optional image URL for character responses
}

interface Thread {
  id: string
  name: string
  messages: Message[]
  createdAt: number
  characterId: number
  isEditing?: boolean
}

interface GeneratedImage {
  url: string
  prompt: string
  createdAt: number
}

const INITIAL_THREADS: Thread[] = []

export default function ChatbotPage() {
  const [grokKey, setGrokKey] = useState('')
  const [fluxKey, setFluxKey] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [threads, setThreads] = useState<Thread[]>(INITIAL_THREADS)
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [imagePrompt, setImagePrompt] = useState('')
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [selectedCharacter, setSelectedCharacter] = useState<ChatCharacter | null>(null)
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingThreadName, setEditingThreadName] = useState('')
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(null)
  const [selectedChatImage, setSelectedChatImage] = useState<{url: string, prompt?: string} | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [characters, setCharacters] = useState<ChatCharacter[]>([])

  // Load threads and images from local storage
  useEffect(() => {
    const savedThreads = localStorage.getItem('chatThreads')
    if (savedThreads) {
      const parsedThreads = JSON.parse(savedThreads)
      setThreads(parsedThreads)
      if (parsedThreads.length > 0 && !currentThreadId) {
        setCurrentThreadId(parsedThreads[0].id)
      }
    }

    const savedImages = localStorage.getItem('generatedImages')
    if (savedImages) {
      setGeneratedImages(JSON.parse(savedImages))
    }
  }, [])

  // Save threads and images to local storage
  useEffect(() => {
    if (threads.length > 0) {
      localStorage.setItem('chatThreads', JSON.stringify(threads))
    }
  }, [threads])

  useEffect(() => {
    if (generatedImages.length > 0) {
      localStorage.setItem('generatedImages', JSON.stringify(generatedImages))
    }
  }, [generatedImages])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
  }, [threads, currentThreadId])

  const createNewThread = async () => {
    const character = characters.find(c => c.characterid === selectedCharacter?.characterid) || characters[0]
    const newThread: Thread = {
      id: Date.now().toString(),
      name: `${character.name} Chat`,
      messages: [],
      createdAt: Date.now(),
      characterId: character.characterid
    }
    setThreads([newThread, ...threads])
    setCurrentThreadId(newThread.id)

    // If character has no image, generate one in the background
    if (!character.image1url && fluxKey) {
      try {
        const basePrompt = `Create an anime style portrait of ${character.name}, a ${character.bio?.split('.')[0]}. Character shown in a noble pose, facing slightly to the side, elegant and composed. Expression is confident and cheerful. Premium quality background with subtle magical effects. High-quality anime art style, clean lines, vibrant colors.`
        
        const response = await fetch('/api/flux', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            prompt: basePrompt,
            seed: Math.floor(Math.random() * 1000000)
          })
        })

        if (!response.ok) throw new Error('Failed to generate image')
        const data = await response.json()
        
        // Store image using server-side API route
        const storeResponse = await fetch('/api/store-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            characterId: character.characterid,
            url: data.image_url,
            prompt: basePrompt,
            style: 'anime',
            seed: Math.floor(Math.random() * 1000000)
          })
        })

        if (!storeResponse.ok) throw new Error('Failed to store image')
        
        // Refresh characters to get the new image
        loadCharacters()
      } catch (error) {
        console.error('Error generating character image:', error)
        // Don't show error to user since this is a background operation
      }
    }
  }

  const deleteThread = (threadId: string) => {
    setThreads(threads.filter(t => t.id !== threadId))
    if (currentThreadId === threadId) {
      setCurrentThreadId(threads[0]?.id || null)
    }
  }

  const getCurrentThread = () => {
    return threads.find(t => t.id === currentThreadId)
  }

  const updateThreadMessages = (threadId: string, messages: Message[]) => {
    setThreads(threads.map(t => 
      t.id === threadId ? { ...t, messages } : t
    ))
  }

  const handleSendMessage = async () => {
    if (!input.trim() || !currentThreadId) return
    
    const thread = getCurrentThread()
    if (!thread) return

    const character = characters.find(c => c.characterid === thread.characterId) || characters[0]
    const newMessage: Message = { role: 'user', content: input }
    const newMessages = [...thread.messages, newMessage]
    updateThreadMessages(currentThreadId, newMessages)
    setInput('')
    setIsLoading(true)

    try {
      const systemMessage: Message = { 
        role: 'system', 
        content: `You are ${character.name} from ${character.Series?.name || 'unknown series'}. ${character.bio}`,
        imageUrl: character.image1url || undefined
      }
      
      // Clean and limit message history
      const cleanedMessages = thread.messages
        .filter(msg => msg.content.trim() !== '')
        .map(msg => ({
          role: msg.role,
          content: msg.content
            .replace(/Generated image for:.*$/, '')
            .replace(/Generate_Image:.*$/, '')
            .trim()
        }))
        .filter(msg => msg.content !== '')
        .slice(-10)

      const messageHistory = [
        systemMessage,
        ...cleanedMessages,
        newMessage
      ]

      const response = await sendGrokMessage(input, messageHistory, grokKey || undefined, character.bio)
      
      if (response?.content) {
        const imageMatch = response.content.match(/Generate_Image:\s*(.+?)(?:\n|$)/)
        const messageContent = response.content.replace(/Generate_Image:\s*(.+?)(?:\n|$)/, '').trim()
        
        let updatedMessages = [...newMessages]

        // Add the assistant's text response first if it exists
        if (messageContent) {
          const assistantMessage: Message = { role: 'assistant', content: messageContent }
          updatedMessages = [...updatedMessages, assistantMessage]
          updateThreadMessages(currentThreadId, updatedMessages)
        }
        
        // Handle image generation if present
        if (imageMatch && imageMatch[1]?.trim()) {
          const imagePrompt = imageMatch[1].trim()
          try {
            const imageResponse = await generateImage(imagePrompt, fluxKey || undefined)
            if (imageResponse?.image_url) {
              const imageMessage: Message = {
                role: 'assistant',
                content: `Generated image for: ${imagePrompt}`,
                imageUrl: imageResponse.image_url
              }
              updatedMessages = [...updatedMessages, imageMessage]
              updateThreadMessages(currentThreadId, updatedMessages)

              // Add to gallery
              setGeneratedImages(prevImages => [{
                url: imageResponse.image_url,
                prompt: imagePrompt,
                createdAt: Date.now()
              }, ...prevImages])
            }
          } catch (error) {
            console.error('Error generating image:', error)
            const errorMessage: Message = {
              role: 'assistant',
              content: 'Sorry, there was an error generating the image. Please try again.'
            }
            updatedMessages = [...updatedMessages, errorMessage]
            updateThreadMessages(currentThreadId, updatedMessages)
          }
        }
      }
    } catch (error) {
      console.error('Error sending message:', error)
      const errorMessage: Message = {
        role: 'assistant',
        content: 'Sorry, there was an error processing your message. Please try again.'
      }
      updateThreadMessages(currentThreadId, [...newMessages, errorMessage])
    } finally {
      setIsLoading(false)
    }
  }

  const handleGenerateImage = async () => {
    if (!imagePrompt.trim()) return
    
    setIsLoading(true)
    try {
      const response = await generateImage(imagePrompt, fluxKey || undefined)
      
      // Add to gallery
      setGeneratedImages(prevImages => [{
        url: response.image_url,
        prompt: imagePrompt,
        createdAt: Date.now()
      }, ...prevImages])

      if (currentThreadId) {
        const thread = getCurrentThread()
        if (thread) {
          const userMessage: Message = { role: 'user', content: `Generated image: ${imagePrompt}` }
          const assistantMessage: Message = { 
            role: 'assistant', 
            content: `Generated image for: ${imagePrompt}`, 
            imageUrl: response.image_url 
          }
          const updatedMessages = [...thread.messages, userMessage, assistantMessage]
          updateThreadMessages(currentThreadId, updatedMessages)
        }
      }
      setImagePrompt('')
    } catch (error) {
      console.error('Error generating image:', error)
      if (currentThreadId) {
        const thread = getCurrentThread()
        if (thread) {
          const errorMessage: Message = { 
            role: 'assistant', 
            content: 'Sorry, there was an error generating the image. Please try again.' 
          }
          const updatedMessages = [...thread.messages, errorMessage]
          updateThreadMessages(currentThreadId, updatedMessages)
        }
      }
    } finally {
      setIsLoading(false)
    }
  }

  const deleteImage = (createdAt: number) => {
    setGeneratedImages(generatedImages.filter(img => img.createdAt !== createdAt))
  }

  const startEditingThread = (threadId: string) => {
    const thread = threads.find(t => t.id === threadId)
    if (thread) {
      setEditingThreadId(threadId)
      setEditingThreadName(thread.name)
    }
  }

  const saveThreadName = (threadId: string) => {
    setThreads(threads.map(t => 
      t.id === threadId ? { ...t, name: editingThreadName } : t
    ))
    setEditingThreadId(null)
  }

  // Update loadCharacters to use Roster directly
  const loadCharacters = async () => {
    try {
      const { data: characters, error } = await supabase
        .from('Roster')
        .select(`
          *,
          Series (
            name,
            universe
          )
        `)
        .order('name')

      if (error) throw error
      
      if (characters) {
        // Map characters to include display image
        const chars = characters.map(char => ({
          ...char,
          displayImage: char.image1url || '/default-character.png'
        }))
        setCharacters(chars)
        // Set initial selected character if none selected
        if (!selectedCharacter && chars.length > 0) {
          setSelectedCharacter(chars[0])
        }
      }
    } catch (err) {
      console.error('Error loading characters:', err)
      setError('Failed to load characters')
    }
  }

  useEffect(() => {
    loadCharacters()
  }, [])

  return (
    <main className="min-h-screen bg-gray-900/90 text-white overflow-hidden">
      <StarField />
      
      {/* Main Content */}
      <div className="fixed inset-0 flex z-10">
        {/* Sidebar - keeping sidebar fixed */}
        <div className={`fixed md:relative inset-y-0 left-0 w-72 bg-gray-800/50 backdrop-blur-sm border-r border-gray-700 transform transition-transform duration-300 flex flex-col ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
          <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex-shrink-0 p-4">
              <div className="flex items-center justify-between mb-6">
                <Link href="/" className="flex items-center space-x-2 text-blue-400 hover:text-blue-300 transition-colors">
                  <Home size={20} />
                  <span>Home</span>
                </Link>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowSettings(!showSettings)}
                  className="text-gray-400 hover:text-white"
                >
                  <Settings size={20} />
                </Button>
              </div>

              {/* Settings Panel */}
              {showSettings && (
                <Card className="p-4 mb-4 bg-gray-800/50 border-gray-700 backdrop-blur-sm animate-float">
                  <h3 className="text-lg font-semibold mb-4 text-blue-400">API Settings</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm mb-1">Grok API Key</label>
                      <Input
                        type="password"
                        value={grokKey}
                        onChange={(e) => setGrokKey(e.target.value)}
                        className="bg-gray-900/50 border-gray-700"
                      />
                    </div>
                    <div>
                      <label className="block text-sm mb-1">Flux API Key</label>
                      <Input
                        type="password"
                        value={fluxKey}
                        onChange={(e) => setFluxKey(e.target.value)}
                        className="bg-gray-900/50 border-gray-700"
                      />
                    </div>
                  </div>
                </Card>
              )}

              {/* New Chat Button */}
              <div className="flex items-center space-x-2 mb-4">
                <Select 
                  value={selectedCharacter?.name} 
                  onValueChange={(value) => setSelectedCharacter(characters.find(c => c.name === value) || null)}
                >
                  <SelectTrigger className="bg-gray-900/50 border-gray-700">
                    <SelectValue placeholder="Select a character" />
                  </SelectTrigger>
                  <SelectContent>
                    {characters.map(c => (
                      <SelectItem key={c.characterid} value={c.name}>
                        <div className="flex items-center space-x-2">
                          <Image 
                            src={c.displayImage} 
                            alt={c.name} 
                            width={24} 
                            height={24} 
                            className="rounded-full object-cover"
                          />
                          <span>{c.name}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  onClick={createNewThread}
                  className="bg-blue-600 hover:bg-blue-500 text-white"
                >
                  <Plus size={20} />
                </Button>
              </div>
            </div>

            {/* Thread List */}
            <div className="flex-1 overflow-y-auto px-4 pb-4">
              <div className="space-y-2">
                {threads.map(thread => (
                  <div
                    key={thread.id}
                    className={`group flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all duration-200 ${
                      currentThreadId === thread.id
                        ? 'bg-blue-600/20 border border-blue-500'
                        : 'hover:bg-gray-700/50 border border-transparent'
                    }`}
                    onClick={() => setCurrentThreadId(thread.id)}
                  >
                    <div className="flex items-center space-x-2 flex-1 min-w-0">
                      <Image
                        src={characters.find(c => c.characterid === thread.characterId)?.displayImage || '/default-character.png'}
                        alt="Character"
                        width={24}
                        height={24}
                        className="rounded-full object-cover"
                      />
                      {editingThreadId === thread.id ? (
                        <Input
                          value={editingThreadName}
                          onChange={(e) => setEditingThreadName(e.target.value)}
                          onBlur={() => saveThreadName(thread.id)}
                          onKeyDown={(e) => e.key === 'Enter' && saveThreadName(thread.id)}
                          className="bg-gray-900/50 border-gray-700"
                          autoFocus
                        />
                      ) : (
                        <span className="truncate">{thread.name}</span>
                      )}
                    </div>
                    <div className="flex space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditingThread(thread.id);
                        }}
                        className="text-gray-400 hover:text-white"
                      >
                        <Edit2 size={16} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteThread(thread.id);
                        }}
                        className="text-gray-400 hover:text-red-400"
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Main Chat Area - Ensuring it stays within viewport */}
        <div className="flex-1 flex flex-col h-screen overflow-hidden">
          <Tabs defaultValue="chat" className="flex-1 flex flex-col">
            <div className="flex-shrink-0 border-b border-gray-700 bg-gray-800/50 backdrop-blur-sm p-2">
              <TabsList className="bg-gray-900/50">
                <TabsTrigger value="chat" className="data-[state=active]:bg-blue-600">
                  <MessageSquare className="w-4 h-4 mr-2" />
                  Chat
                </TabsTrigger>
                <TabsTrigger value="images" className="data-[state=active]:bg-blue-600">
                  <ImageIcon className="w-4 h-4 mr-2" />
                  Images
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="chat" className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {getCurrentThread()?.messages.map((message, index) => (
                  <div
                    key={index}
                    className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[80%] p-4 rounded-xl backdrop-blur-sm animate-float ${
                        message.role === 'user'
                          ? 'bg-blue-600/20 border border-blue-500'
                          : 'bg-gray-800/50 border border-gray-700'
                      }`}
                    >
                      {message.imageUrl && (
                        <div className="mt-2">
                          <img src={message.imageUrl} alt="Character" className="max-w-xs rounded-lg" />
                        </div>
                      )}
                      <div className="whitespace-pre-wrap">{message.content}</div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
              {/* Input Area - Keep at bottom */}
              <div className="flex-shrink-0 border-t border-gray-700 bg-gray-800/50 backdrop-blur-sm p-4">
                <div className="flex space-x-2">
                  <Input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSendMessage()}
                    placeholder="Type a message..."
                    className="bg-gray-900/50 border-gray-700"
                    disabled={isLoading}
                  />
                  <Button
                    onClick={handleSendMessage}
                    disabled={isLoading}
                    className="bg-blue-600 hover:bg-blue-500"
                  >
                    Send
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="images" className="flex-1 overflow-y-auto p-4">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {generatedImages.map((img) => (
                  <div
                    key={img.createdAt}
                    className="group relative aspect-square rounded-xl overflow-hidden border border-gray-700 hover:border-blue-500 transition-all duration-300 cursor-pointer animate-float"
                    onClick={() => setSelectedImage(img)}
                  >
                    <Image
                      src={img.url}
                      alt={img.prompt}
                      fill
                      className="object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-gray-900 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="absolute bottom-0 left-0 right-0 p-4">
                        <p className="text-sm text-white line-clamp-2">{img.prompt}</p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteImage(img.createdAt);
                      }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Image Preview Modal */}
      {(selectedImage || selectedChatImage) && (
        <div 
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => {
            setSelectedImage(null);
            setSelectedChatImage(null);
          }}
        >
          <div 
            className="relative max-w-4xl w-full bg-gray-800/90 rounded-xl p-4 animate-float"
            onClick={(e) => e.stopPropagation()} // Prevent clicks on the content from closing the modal
          >
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 right-2 z-10 hover:bg-gray-700/50"
              onClick={() => {
                setSelectedImage(null);
                setSelectedChatImage(null);
              }}
            >
              <X className="w-6 h-6" />
            </Button>
            <img
              src={selectedImage?.url || selectedChatImage?.url || ''}
              alt={selectedImage?.prompt || selectedChatImage?.prompt || ''}
              className="w-full h-auto rounded-lg"
            />
            <p className="mt-4 text-gray-300">{selectedImage?.prompt || selectedChatImage?.prompt}</p>
          </div>
        </div>
      )}
    </main>
  )
} 