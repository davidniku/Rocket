import React, { useMemo, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilValue } from 'recoil';
import { Constants, QueryKeys } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import store from '~/store';

// Model pricing data (per 1M tokens, using average of prompt+completion)
const MODEL_PRICING: Record<string, number> = {
  // OpenAI
  'gpt-4o': 10.0,
  'gpt-4o-mini': 0.375,
  'gpt-4-turbo': 20.0,
  'gpt-4': 45.0,
  'gpt-4-0613': 45.0,
  'gpt-4-0314': 45.0,
  'gpt-4-32k': 90.0,
  'gpt-3.5-turbo': 1.0,
  'gpt-3.5-turbo-16k': 3.5,
  o1: 37.5,
  'o1-mini': 7.5,
  'o1-preview': 37.5,

  // Anthropic
  'claude-3-5-sonnet': 9.0,
  'claude-3-5-haiku': 2.4,
  'claude-3-opus': 45.0,
  'claude-3-sonnet': 9.0,
  'claude-3-haiku': 0.75,
  'claude-2.1': 16.0,
  'claude-2': 16.0,
  'claude-instant': 0.8,

  // Google
  'gemini-1.5-pro': 6.25,
  'gemini-1.5-flash': 0.375,
  'gemini-1.5-flash-8b': 0.1875,
  'gemini-pro': 1.0,
  'gemini-2.0': 0.375,

  // Default fallback
  default: 1.0,
};

// Estimate tokens from text (rough approximation: 4 chars ≈ 1 token)
const estimateTokens = (text: string): number => {
  if (!text) return 0;
  // Rough estimation: ~4 characters per token for English text
  // This is a simplification but works reasonably well for real-time updates
  return Math.ceil(text.length / 4);
};

// Get base model name for pricing lookup
const getBaseModel = (model: string | null): string => {
  if (!model) return 'default';

  const modelLower = model.toLowerCase();

  // Check for exact match first
  if (MODEL_PRICING[model]) return model;

  // Find the best matching model in our pricing data
  for (const key of Object.keys(MODEL_PRICING)) {
    if (modelLower.includes(key.toLowerCase()) || key.toLowerCase().includes(modelLower)) {
      return key;
    }
  }

  // Check for provider patterns
  if (modelLower.includes('gpt-4-32k')) return 'gpt-4-32k';
  if (modelLower.includes('gpt-4')) return 'gpt-4';
  if (modelLower.includes('gpt-3.5-turbo-16k')) return 'gpt-3.5-turbo-16k';
  if (modelLower.includes('gpt-3.5')) return 'gpt-3.5-turbo';
  if (modelLower.includes('claude-3-opus')) return 'claude-3-opus';
  if (modelLower.includes('claude-3-sonnet')) return 'claude-3-sonnet';
  if (modelLower.includes('claude-3-haiku')) return 'claude-3-haiku';
  if (modelLower.includes('claude-3-5')) return 'claude-3-5-sonnet';
  if (modelLower.includes('claude-2')) return 'claude-2';
  if (modelLower.includes('claude-instant')) return 'claude-instant';
  if (modelLower.includes('claude')) return 'claude-3-haiku';
  if (modelLower.includes('gemini-1.5-pro')) return 'gemini-1.5-pro';
  if (modelLower.includes('gemini-1.5-flash')) return 'gemini-1.5-flash';
  if (modelLower.includes('gemini')) return 'gemini-1.5-flash';
  if (modelLower.includes('o1-preview')) return 'o1-preview';
  if (modelLower.includes('o1-mini')) return 'o1-mini';
  if (modelLower.includes('o1')) return 'o1';

  return 'default';
};

export default function ConversationCost() {
  const { conversationId } = useParams();
  const queryClient = useQueryClient();

  // Watch for streaming updates - check all possible indexes
  const latestMessage0 = useRecoilValue(store.latestMessageFamily(0));
  const latestMessage1 = useRecoilValue(store.latestMessageFamily(1));
  const latestMessage2 = useRecoilValue(store.latestMessageFamily(2));

  // Find the latest message that matches our conversation
  const latestMessage = useMemo(() => {
    if (latestMessage0?.conversationId === conversationId) return latestMessage0;
    if (latestMessage1?.conversationId === conversationId) return latestMessage1;
    if (latestMessage2?.conversationId === conversationId) return latestMessage2;
    return null;
  }, [latestMessage0, latestMessage1, latestMessage2, conversationId]);

  // Force update when latest message changes (during streaming)
  useEffect(() => {
    // Trigger re-render when streaming message updates
  }, [latestMessage]);

  // Subscribe to React Query cache updates
  const [messages, setMessages] = useState<TMessage[]>([]);

  useEffect(() => {
    // Initial fetch
    const initialMessages =
      queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId]) || [];
    setMessages(initialMessages);

    // Subscribe to cache updates
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event?.query?.queryKey?.[0] === QueryKeys.messages &&
        event?.query?.queryKey?.[1] === conversationId
      ) {
        const updatedMessages =
          queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId]) || [];
        setMessages(updatedMessages);
      }
    });

    return () => unsubscribe();
  }, [conversationId, queryClient]);

  // Combine cached messages with the latest streaming message if it exists
  const allMessages = useMemo(() => {
    const msgs = [...messages];

    // If there's a streaming message that's not in the cache yet, add it
    if (latestMessage && latestMessage.conversationId === conversationId) {
      const existingIndex = msgs.findIndex((m) => m.messageId === latestMessage.messageId);
      if (existingIndex >= 0) {
        // Update existing message with latest text
        msgs[existingIndex] = { ...msgs[existingIndex], ...latestMessage };
      } else if (latestMessage.text) {
        // Add new streaming message
        msgs.push(latestMessage);
      }
    }

    return msgs;
  }, [messages, latestMessage, conversationId]);

  // Calculate cost in real-time from all messages
  const costData = useMemo(() => {
    if (!allMessages || allMessages.length === 0) {
      return null;
    }

    let totalCost = 0;
    let totalTokens = 0;
    const modelCosts = new Map<string, number>();

    // Process each message
    allMessages.forEach((message: TMessage) => {
      // Extract token count from various possible fields
      let tokenCount = 0;
      let isEstimated = false;

      // Check different token count formats - prefer actual counts over estimates
      if (message.tokenCount && typeof message.tokenCount === 'number') {
        // Actual token count from the model API
        tokenCount = message.tokenCount;
      } else if (message.usage) {
        // Usage object format (OpenAI style)
        const usage = message.usage as any;
        tokenCount = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
      } else if (message.tokens) {
        // Tokens object format (alternative style)
        const tokens = message.tokens as any;
        tokenCount =
          (tokens.prompt || tokens.input || 0) + (tokens.completion || tokens.output || 0);
      } else if (message.text) {
        // Fallback: estimate from text (only for messages still streaming)
        tokenCount = estimateTokens(message.text);
        isEstimated = true;
      }

      // Skip if no tokens
      if (tokenCount === 0) return;

      totalTokens += tokenCount;

      // Calculate cost for both user and assistant messages
      // For user messages, use the last known model or default
      const messageModel = message.model || allMessages.find((m) => m.model)?.model;
      if (messageModel || message.isCreatedByUser) {
        const model = messageModel || 'gpt-3.5-turbo'; // Default model for estimation
        const baseModel = getBaseModel(model);
        const pricePerMillion = MODEL_PRICING[baseModel] || MODEL_PRICING.default;

        // Only apply estimation adjustment for client-side estimates
        const adjustedTokenCount = isEstimated ? tokenCount * 0.85 : tokenCount;
        const messageCost = (adjustedTokenCount / 1_000_000) * pricePerMillion;

        totalCost += messageCost;

        // Track per-model costs
        if (messageModel) {
          const currentModelCost = modelCosts.get(model) || 0;
          modelCosts.set(model, currentModelCost + messageCost);
        }
      }
    });

    // Find primary model (most expensive)
    let primaryModel = 'Unknown';
    let maxCost = 0;
    modelCosts.forEach((cost, model) => {
      if (cost > maxCost) {
        maxCost = cost;
        primaryModel = model;
      }
    });

    // Format cost for display
    const formatCost = (cost: number) => {
      if (cost === 0) return '$0.00';
      if (cost < 0.001) return '<$0.001';
      if (cost < 0.01) return `$${cost.toFixed(4)}`;
      if (cost < 1) return `$${cost.toFixed(3)}`;
      return `$${cost.toFixed(2)}`;
    };

    return {
      totalCost: formatCost(totalCost),
      totalCostRaw: totalCost,
      primaryModel,
      totalTokens,
      lastUpdated: new Date(),
    };
  }, [allMessages]);

  // Helper function to get color class based on cost
  const getCostColorClass = (cost: number) => {
    if (cost < 0.01) return 'text-green-600 dark:text-green-400';
    if (cost < 0.1) return 'text-yellow-600 dark:text-yellow-400';
    if (cost < 1) return 'text-orange-600 dark:text-orange-400';
    return 'text-red-600 dark:text-red-400';
  };

  // Don't show for new conversations
  if (!conversationId || conversationId === Constants.NEW_CONVO) {
    return null;
  }

  // Show placeholder if no cost data yet
  if (!costData || costData.totalCostRaw === 0) {
    return (
      <div className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-400">
        <span>💰</span>
        <span>$0.00</span>
      </div>
    );
  }

  const tooltipText = `Cost: ${costData.totalCost} | Model: ${costData.primaryModel} | Tokens: ${costData.totalTokens.toLocaleString()} | Updated: ${new Date(costData.lastUpdated).toLocaleTimeString()}`;

  return (
    <div
      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors hover:bg-surface-hover"
      title={tooltipText}
    >
      <span className="text-text-tertiary">💰</span>
      <span className={`font-medium ${getCostColorClass(costData.totalCostRaw)}`}>
        {costData.totalCost}
      </span>
    </div>
  );
}
